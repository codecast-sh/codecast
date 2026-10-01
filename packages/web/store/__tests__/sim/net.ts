// The sim's network and scheduler (docs/architecture/multiplayer-sim-harness.md
// section 3.4). Every event the simulation produces (a request, a response, a
// live query push, a replication post, a timer, a scheduled job, an actor
// verb) is a Delivery on a named channel, and this module decides which one
// runs next.
//
// Pure: it never imports the store. It only reads the HIDDEN_OVERRIDE_SETTLE_MS
// constant from the store's leaf overlays module.
//
// Ordering rules:
// - A channel is FIFO. Deliveries due at the same time run in the order they
//   were enqueued; one due later never blocks one due earlier (timers on one
//   owner fire by deadline, as setTimeout does).
// - A delivery is ready when its channel is not lagged, not held by an offline
//   window, and its due time has come.
// - "scripted" runs the lexicographically first ready channel, "interleave" a
//   seeded choice among ready channels, and { order } replays a recorded
//   channel list (from orderSoFar), throwing when the run diverges from it.
//   Once the list is used up, order mode continues as scripted, so a partial
//   order pins only the deliveries a scenario cares about.

import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../inboxOverlays";

/** "conn:<win>", "live:<win>:<feed>", "repl:<from>><to>", "bridge:<dev>:<from>", "timer:<owner>", "sched", "actor:<name>" */
export type Channel = string;

export interface Delivery {
  seq: number;
  channel: Channel;
  due: number;
  label: string;
  run: () => Promise<void> | void;
  producer: string;
}

/** What enqueue takes: `due` defaults to now, `channel` to the channel argument. */
export type DeliveryInit = Omit<Delivery, "seq" | "channel" | "due"> & { channel?: Channel; due?: number };

/** A mounted live query: its refresh recomputes the query when it is delivered, not when it was marked. */
export interface LiveMount {
  run: () => Promise<void> | void;
  label?: string;
  producer?: string;
}

export type NetMode = "scripted" | "interleave" | { order: Channel[] };

/**
 * Narrows step and drain to the channels it accepts. The legacy suites
 * (inboxSimHarness.ts) use it to deliver one device's window traffic, or
 * everything but the live feeds, at the moments they choose.
 */
export type ChannelFilter = (channel: Channel) => boolean;

export const DEFAULT_MAX_DELIVERIES = 5000;
export const DEFAULT_MAX_WRITES = 2000;
export const DEFAULT_DRAIN_HORIZON_MS = 2 * HIDDEN_OVERRIDE_SETTLE_MS;
const RING_SIZE = 64;
const TOP_PRODUCERS = 5;

export type SimNetErrorCode = "no-quiescence" | "write-budget" | "order-mismatch";

export class SimNetError extends Error {
  constructor(readonly code: SimNetErrorCode, message: string) {
    super(message);
    this.name = "SimNetError";
  }
}

export interface NetOptions {
  /** The net's own seeded stream. Order replay draws nothing from it, so it must not be shared with anything else. */
  rng: () => number;
  maxDeliveries?: number;
  maxWrites?: number;
  /** The server's total write count. */
  writes: () => number;
  now: () => number;
  advance: (ms: number) => void;
  /** Called by online(win), so the window can drain its outbox (the net never touches the store). */
  onOnline?: (win: string) => void;
  /** Called with each delivery just before it runs (tracing, events.jsonl). */
  onDeliver?: (d: Delivery) => void;
  /**
   * Awaited after each delivery has run and its writes were counted (the
   * DSL's always-mode invariant checks). A throw propagates out of step().
   */
  afterDeliver?: (d: Delivery) => Promise<void> | void;
}

/** The --order replay line: channels separated by spaces (channel names hold no whitespace). */
export function formatOrder(channels: readonly Channel[]): string {
  return channels.join(" ");
}

/** Reads a --order / SIM_ORDER value; accepts spaces or commas between channels. */
export function parseOrder(s: string): Channel[] {
  return s.split(/[\s,]+/).filter(Boolean);
}

function rankLine(counts: Map<string, number>): string {
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, TOP_PRODUCERS);
  return top.length ? top.map(([name, n]) => `${name} (${n})`).join(", ") : "none";
}

export class Net {
  ring: Delivery[] = [];

  private readonly opts: NetOptions;
  private readonly maxDeliveries: number;
  private readonly maxWrites: number;
  // Channels with at least one queued delivery; a channel leaves when its queue empties.
  private readonly queues = new Map<Channel, Delivery[]>();
  private readonly lagged = new Set<Channel>();
  private readonly offlineWins = new Set<string>();
  // The window a conn: or live: channel belongs to (null for any other channel), parsed once.
  private readonly windowOf = new Map<Channel, string | null>();
  private readonly mounts = new Map<Channel, LiveMount>();
  private readonly dirtyPending = new Map<Channel, number>();
  private readonly delivered = new Map<string, number>();
  private readonly wrote = new Map<string, number>();
  private readonly order: Channel[] = [];
  private _mode: NetMode = "scripted";
  private orderPos = 0;
  private nextSeq = 1;
  private deliveryCount = 0;
  private spentWrites = 0;
  private lastWrites: number;

  constructor(opts: NetOptions) {
    this.opts = opts;
    this.maxDeliveries = opts.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;
    this.maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES;
    this.lastWrites = opts.writes();
  }

  get mode(): NetMode {
    return this._mode;
  }

  /** Setting a mode restarts an order replay from the head of its list. */
  set mode(m: NetMode) {
    this._mode = m;
    this.orderPos = 0;
  }

  /** Deliveries run so far. */
  get deliveries(): number {
    return this.deliveryCount;
  }

  /** Server writes made by deliveries (writes outside a delivery, like genesis, are not budgeted). */
  get writesSpent(): number {
    return this.spentWrites;
  }

  /** Queues a delivery and returns its seq, which cancel() takes. */
  enqueue(channel: Channel, d: DeliveryInit): number {
    if (d.channel !== undefined && d.channel !== channel) {
      throw new Error(`sim net: enqueue on "${channel}" given a delivery for "${d.channel}"`);
    }
    const delivery: Delivery = { ...d, seq: this.nextSeq++, channel, due: d.due ?? this.opts.now() };
    let q = this.queues.get(channel);
    if (!q) this.queues.set(channel, (q = []));
    let i = q.length;
    while (i > 0 && q[i - 1].due > delivery.due) i--;
    q.splice(i, 0, delivery);
    return delivery.seq;
  }

  /** Removes a queued delivery (clearTimeout, a canceled job). False when it already ran or never existed. */
  cancel(seq: number): boolean {
    for (const [channel, q] of this.queues) {
      const i = q.findIndex((d) => d.seq === seq);
      if (i < 0) continue;
      q.splice(i, 1);
      if (!q.length) this.queues.delete(channel);
      if (this.dirtyPending.get(channel) === seq) this.dirtyPending.delete(channel);
      return true;
    }
    return false;
  }

  mountLive(channel: Channel, mount: LiveMount): void {
    if (this.mounts.has(channel)) throw new Error(`sim net: live channel "${channel}" is already mounted`);
    this.mounts.set(channel, mount);
  }

  unmountLive(channel: Channel): void {
    this.mounts.delete(channel);
    const seq = this.dirtyPending.get(channel);
    if (seq !== undefined) this.cancel(seq);
  }

  /** Live refresh: at most one pending per live channel. */
  markDirty(channel: Channel): void {
    const mount = this.mounts.get(channel);
    if (!mount) throw new Error(`sim net: markDirty("${channel}") on a channel with no mounted live query`);
    if (this.dirtyPending.has(channel)) return;
    const seq = this.enqueue(channel, {
      label: mount.label ?? `refresh ${channel}`,
      producer: mount.producer ?? channel,
      run: mount.run,
    });
    this.dirtyPending.set(channel, seq);
  }

  /** Holds the window's conn: and live: channels until online(win). */
  offline(win: string): void {
    this.offlineWins.add(win);
  }

  online(win: string): void {
    if (!this.offlineWins.delete(win)) return;
    this.opts.onOnline?.(win);
  }

  lag(channel: Channel): void {
    this.lagged.add(channel);
  }

  release(channel: Channel): void {
    this.lagged.delete(channel);
  }

  /** The channel's deliveries are held: it is lagged, or it is a conn or live channel of an offline window. */
  held(channel: Channel): boolean {
    return this.blocked(channel);
  }

  /** Runs one delivery per the mode rules, or returns null when nothing is ready (among the channels `only` accepts). */
  async step(only?: ChannelFilter): Promise<Delivery | null> {
    this.noticeWrites();
    const channel = this.next(only);
    if (channel === null) return null;
    if (this.deliveryCount >= this.maxDeliveries) {
      throw new SimNetError(
        "no-quiescence",
        `sim net: did not quiesce after ${this.maxDeliveries} deliveries; top producers: ${rankLine(this.delivered)}`,
      );
    }
    const q = this.queues.get(channel)!;
    const d = q.shift()!;
    // Only channels with work stay in the map: every step scans it.
    if (!q.length) this.queues.delete(channel);
    if (this.dirtyPending.get(channel) === d.seq) this.dirtyPending.delete(channel);
    this.deliveryCount++;
    this.order.push(channel);
    this.ring.push(d);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.delivered.set(d.producer, (this.delivered.get(d.producer) ?? 0) + 1);
    this.opts.onDeliver?.(d);

    const before = this.opts.writes();
    await d.run();
    const spent = this.opts.writes() - before;
    if (spent > 0) {
      this.spentWrites += spent;
      this.wrote.set(d.producer, (this.wrote.get(d.producer) ?? 0) + spent);
      if (this.spentWrites > this.maxWrites) {
        throw new SimNetError(
          "write-budget",
          `sim net: ${this.spentWrites} server writes exceeded the budget of ${this.maxWrites} at delivery ${this.deliveryCount} ("${d.label}" on ${channel}); top writers: ${rankLine(this.wrote)}`,
        );
      }
    }
    this.noticeWrites();
    await this.opts.afterDeliver?.(d);
    return d;
  }

  /**
   * Runs deliveries until none is ready, then moves the clock to the next
   * delivery that waits only on time, as long as it falls within horizonMs of
   * the drain's start. Stops when nothing is due inside the horizon.
   */
  async drain(opts: { horizonMs?: number; only?: ChannelFilter } = {}): Promise<void> {
    const until = this.opts.now() + (opts.horizonMs ?? DEFAULT_DRAIN_HORIZON_MS);
    for (;;) {
      while (await this.step(opts.only)) {}
      const next = this.nextDue(opts.only);
      if (next === null || next > until) return;
      this.opts.advance(next - this.opts.now());
    }
  }

  /** Deliveries queued (ready or not) on the channels `only` accepts. */
  queued(only?: ChannelFilter): number {
    let n = 0;
    for (const [channel, q] of this.queues) if (!only || only(channel)) n += q.length;
    return n;
  }

  /** Channels of every delivery so far, in run order: the --order replay list. */
  orderSoFar(): Channel[] {
    return [...this.order];
  }

  /** Deliveries run per producer. */
  producers(): Map<string, number> {
    return new Map(this.delivered);
  }

  private blocked(channel: Channel): boolean {
    if (this.lagged.has(channel)) return true;
    if (!this.offlineWins.size) return false;
    let win = this.windowOf.get(channel);
    if (win === undefined) {
      const m = /^(?:conn:([^:]+)$|live:([^:]+):)/.exec(channel);
      this.windowOf.set(channel, (win = m?.[1] ?? m?.[2] ?? null));
    }
    return win !== null && this.offlineWins.has(win);
  }

  // The channel the next step runs, or null when none is ready. Scripted
  // mode (and an order replay that has run out) takes the lexicographically
  // first ready channel in one pass; the other modes choose among them all.
  private next(only?: ChannelFilter): Channel | null {
    const mode = this._mode;
    if (mode === "scripted" || (mode !== "interleave" && this.orderPos >= mode.order.length)) {
      const now = this.opts.now();
      let first: Channel | null = null;
      for (const [channel, q] of this.queues) {
        if ((first === null || channel < first) && q[0].due <= now && !this.blocked(channel) && (!only || only(channel))) first = channel;
      }
      return first;
    }
    const ready = this.readyChannels(only);
    return ready.length ? this.pick(ready) : null;
  }

  private readyChannels(only?: ChannelFilter): Channel[] {
    const now = this.opts.now();
    const ready: Channel[] = [];
    for (const [channel, q] of this.queues) {
      if (q[0].due <= now && !this.blocked(channel) && (!only || only(channel))) ready.push(channel);
    }
    return ready.length > 1 ? ready.sort() : ready;
  }

  /** Earliest due time among deliveries that wait only on the clock. */
  private nextDue(only?: ChannelFilter): number | null {
    let next: number | null = null;
    for (const [channel, q] of this.queues) {
      if (this.blocked(channel) || (only && !only(channel))) continue;
      if (next === null || q[0].due < next) next = q[0].due;
    }
    return next;
  }

  private pick(ready: Channel[]): Channel {
    const mode = this._mode;
    if (mode === "interleave") {
      return ready.length === 1 ? ready[0] : ready[Math.floor(this.opts.rng() * ready.length)];
    }
    if (mode !== "scripted" && this.orderPos < mode.order.length) {
      const want = mode.order[this.orderPos];
      if (!ready.includes(want)) {
        throw new SimNetError(
          "order-mismatch",
          `sim net: order replay diverged at delivery ${this.deliveryCount + 1} (order entry ${this.orderPos + 1}): expected "${want}" but it is not ready; ready: ${ready.join(" ")}`,
        );
      }
      this.orderPos++;
      return want;
    }
    return ready[0];
  }

  /** Any server write since the last look marks every mounted live channel dirty. */
  private noticeWrites(): void {
    const w = this.opts.writes();
    if (w === this.lastWrites) return;
    this.lastWrites = w;
    for (const channel of this.mounts.keys()) this.markDirty(channel);
  }
}
