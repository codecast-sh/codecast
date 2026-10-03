// The Multiplayer sim run as lanes (docs/architecture/evals-ui.md 4.7): pure,
// so the timeline, the order strip and their tests read one model.
//
// What the artifacts mean (store/__tests__/sim/report.ts, net.ts, dsl.ts):
// - events.jsonl lists deliveries in delivery order. A delivery's `seq` is its
//   enqueue number, not its position, so the x axis is the row's index among
//   the deliveries. Step rows sit between deliveries and place a band there.
// - result.json `delivery` is a count: the check failed after that many
//   deliveries, so the failing delivery is index `delivery - 1`.
// - `order` is the recorded channels, read with the sim's own replay.ts
//   parseOrder and shrink.ts splitOrderLine: a scripted run's order leads with
//   the `scripted` mark, which is no delivery. minimal.json `removed` indexes
//   the recorded channels without the mark, so index i of the order is
//   delivery i.

import type { SimEvent, SimWorld } from "@codecast/shared/contracts/evalsApi";
import { traceMatches, type SimLabels } from "../../store/__tests__/sim/labels";

export type ParsedChannel =
  | { kind: "conn"; window: string }
  | { kind: "live"; window: string; feed: string }
  | { kind: "repl"; from: string; to: string }
  | { kind: "bridge"; device: string; from: string }
  | { kind: "timer"; owner: string }
  | { kind: "sched" }
  | { kind: "actor"; name: string }
  | { kind: "other"; raw: string };

/** net.ts Channel: "conn:<win>", "live:<win>:<feed>", "repl:<from>><to>", "bridge:<dev>:<from>", "timer:<owner>", "sched", "actor:<name>". */
export function parseChannel(channel: string): ParsedChannel {
  if (channel === "sched") return { kind: "sched" };
  const i = channel.indexOf(":");
  if (i < 0) return { kind: "other", raw: channel };
  const kind = channel.slice(0, i);
  const rest = channel.slice(i + 1);
  switch (kind) {
    case "conn":
      return { kind: "conn", window: rest };
    case "live": {
      const j = rest.indexOf(":");
      return j < 0 ? { kind: "live", window: rest, feed: "" } : { kind: "live", window: rest.slice(0, j), feed: rest.slice(j + 1) };
    }
    case "repl": {
      const j = rest.indexOf(">");
      return j < 0 ? { kind: "other", raw: channel } : { kind: "repl", from: rest.slice(0, j), to: rest.slice(j + 1) };
    }
    case "bridge": {
      const j = rest.indexOf(":");
      return { kind: "bridge", device: j < 0 ? rest : rest.slice(0, j), from: j < 0 ? "" : rest.slice(j + 1) };
    }
    case "timer":
      return { kind: "timer", owner: rest };
    case "actor":
      return { kind: "actor", name: rest };
    default:
      return { kind: "other", raw: channel };
  }
}

export type SimDelivery = Extract<SimEvent, { channel: string }>;
export type SimStep = Extract<SimEvent, { kind: "step" }>;

export const isStep = (e: SimEvent): e is SimStep => e.kind === "step";

export type LaneKind = "device" | "window" | "sched" | "timer" | "actor" | "other";

export interface Lane {
  id: string;
  kind: LaneKind;
  label: string;
  /** The device a window or device-header lane belongs to. */
  device: string | null;
  role?: "host" | "follower";
  closed?: boolean;
}

export type MarkShape = "conn" | "live" | "repl" | "bridge" | "timer" | "sched" | "actor" | "other";

export interface Mark {
  /** Position among the deliveries: the x axis. */
  i: number;
  seq: number;
  channel: string;
  label: string;
  producer: string;
  shape: MarkShape;
  lane: string;
  /** A replication's receiving lane: the arc runs from `lane` to `toLane`. */
  toLane?: string;
  /** A live channel's feed, which sets its tick colour. */
  feed?: string;
}

export interface StepBand {
  /** Deliveries before the step: the band starts at this index. */
  at: number;
  /** Where the next step begins (or the delivery count). */
  end: number;
  verb: string;
  actor: string;
  label: string;
}

export interface Timeline {
  lanes: Lane[];
  marks: Mark[];
  steps: StepBand[];
  /** Deliveries in the run. */
  count: number;
  /** The last delivery each lane carries, so a closed window's lane ends there. */
  lastIndex: Record<string, number>;
  /** Live feeds in first-seen order, for the colour legend. */
  feeds: string[];
}

const windowLane = (name: string) => `w:${name}`;
const deviceLane = (name: string) => `d:${name}`;

/**
 * Lanes and marks for one run. Devices come from world.json, each a header
 * lane over its windows; channels naming a window the world does not list
 * still get a lane, so an artifact without world.json still draws.
 */
export function buildTimeline(events: readonly SimEvent[], world: SimWorld | null): Timeline {
  const lanes: Lane[] = [];
  const known = new Set<string>();
  const add = (lane: Lane) => {
    if (known.has(lane.id)) return;
    known.add(lane.id);
    lanes.push(lane);
  };
  const deviceOf = new Map<string, string>();
  for (const d of world?.devices ?? []) {
    add({ id: deviceLane(d.name), kind: "device", label: d.name, device: d.name });
    for (const w of d.windows) {
      deviceOf.set(w.name, d.name);
      add({ id: windowLane(w.name), kind: "window", label: w.name, device: d.name, role: w.role, closed: w.closed });
    }
  }

  const deliveries = events.filter((e): e is SimDelivery => !isStep(e));
  const steps: StepBand[] = [];
  let at = 0;
  for (const e of events) {
    if (isStep(e)) steps.push({ at, end: at, verb: e.verb, actor: e.actor, label: e.label });
    else at++;
  }
  for (let k = 0; k < steps.length; k++) steps[k].end = k + 1 < steps.length ? steps[k + 1].at : deliveries.length;

  // Windows the world does not name, then the lanes below them, in first-seen order.
  const extraWindows: string[] = [];
  const sched: string[] = [];
  const timers: string[] = [];
  const actors: string[] = [];
  const others: string[] = [];
  const feeds: string[] = [];
  const seeWindow = (w: string) => {
    if (!known.has(windowLane(w)) && !extraWindows.includes(w)) extraWindows.push(w);
  };
  const parsed = deliveries.map((d) => parseChannel(d.channel));
  for (const p of parsed) {
    if (p.kind === "conn") seeWindow(p.window);
    else if (p.kind === "live") {
      seeWindow(p.window);
      if (!feeds.includes(p.feed)) feeds.push(p.feed);
    } else if (p.kind === "repl") {
      seeWindow(p.from);
      seeWindow(p.to);
    } else if (p.kind === "bridge" && !known.has(deviceLane(p.device))) add({ id: deviceLane(p.device), kind: "device", label: p.device, device: p.device });
    else if (p.kind === "sched" && !sched.length) sched.push("sched");
    else if (p.kind === "timer" && !timers.includes(p.owner)) timers.push(p.owner);
    else if (p.kind === "actor" && !actors.includes(p.name)) actors.push(p.name);
    else if (p.kind === "other" && !others.includes(p.raw)) others.push(p.raw);
  }
  // A world-less run keeps its windows together under one unnamed group.
  for (const w of extraWindows) add({ id: windowLane(w), kind: "window", label: w, device: null });
  if (sched.length) add({ id: "sched", kind: "sched", label: "sched", device: null });
  for (const t of timers) add({ id: `t:${t}`, kind: "timer", label: `timer ${t}`, device: null });
  for (const a of actors) add({ id: `a:${a}`, kind: "actor", label: `actor ${a}`, device: null });
  for (const o of others) add({ id: `o:${o}`, kind: "other", label: o, device: null });

  const marks: Mark[] = deliveries.map((d, i) => {
    const p = parsed[i];
    const base = { i, seq: d.seq, channel: d.channel, label: d.label, producer: d.producer };
    switch (p.kind) {
      case "conn":
        return { ...base, shape: "conn", lane: windowLane(p.window) };
      case "live":
        return { ...base, shape: "live", lane: windowLane(p.window), feed: p.feed };
      case "repl":
        return { ...base, shape: "repl", lane: windowLane(p.from), toLane: windowLane(p.to) };
      case "bridge":
        return { ...base, shape: "bridge", lane: deviceLane(p.device) };
      case "sched":
        return { ...base, shape: "sched", lane: "sched" };
      case "timer":
        return { ...base, shape: "timer", lane: `t:${p.owner}` };
      case "actor":
        return { ...base, shape: "actor", lane: `a:${p.name}` };
      default:
        return { ...base, shape: "other", lane: `o:${p.raw}` };
    }
  });

  const lastIndex: Record<string, number> = {};
  for (const m of marks) {
    lastIndex[m.lane] = m.i;
    if (m.toLane) lastIndex[m.toLane] = m.i;
  }
  return { lanes, marks, steps, count: deliveries.length, lastIndex, feeds };
}

/** The failing delivery's index from result.json's count (null for a pass). */
export const failIndex = (delivery: number | null | undefined, count: number): number | null =>
  delivery === null || delivery === undefined ? null : Math.max(0, Math.min(count - 1, delivery - 1));

/** The labels a run's deliveries touch, most touched first: the trace picker. */
export function traceLabels(marks: readonly Mark[], labels: SimLabels, max = 24): Array<{ label: string; count: number }> {
  const out: Array<{ label: string; count: number }> = [];
  for (const [, label] of labels.entries()) {
    const count = marks.reduce((n, m) => n + (traceMatches(m, label, labels) ? 1 : 0), 0);
    if (count) out.push({ label, count });
  }
  return out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, max);
}

/** The delivery indexes a shrink kept: every recorded index minus `removed` (null before a shrink). */
export function keptIndexes(recorded: number, removed: readonly number[] | null | undefined): Set<number> | null {
  if (!removed) return null;
  const gone = new Set(removed);
  const kept = new Set<number>();
  for (let i = 0; i < recorded; i++) if (!gone.has(i)) kept.add(i);
  return kept;
}

/** "17 recorded, 4 needed (1-minimal)": the order strip's caption. */
export function shrinkCaption(recorded: number, minimal: { order: readonly string[]; oneMinimal: boolean; attempts: number } | null): string {
  if (!minimal) return `${recorded} recorded`;
  return `${recorded} recorded, ${minimal.order.length} needed (${minimal.oneMinimal ? "1-minimal" : "a cap stopped it, not 1-minimal"})`;
}

/** Categorical feed colours. Magenta and red keep their fixed meanings (failure, gates), so feeds never use them. */
export const FEED_TONES = ["var(--sol-blue)", "var(--sol-green)", "var(--sol-violet)", "var(--sol-cyan)", "var(--sol-orange)", "var(--sol-yellow)"] as const;
export const feedTone = (feeds: readonly string[], feed: string | undefined) => (feed === undefined ? "var(--sol-text-muted)" : FEED_TONES[Math.max(0, feeds.indexOf(feed)) % FEED_TONES.length]);

/**
 * What the two columns of a failure's row diff hold. result.json names them
 * `server` and `replica`, but INV-followers fills `server` with the host
 * window's row (invariants.ts), so there the pair is host against follower,
 * named by window from world.json. Every other invariant compares the
 * server's row with the window's replica.
 */
export function rowDiffSides(invariant: string, window: string | null | undefined, world: SimWorld | null): { server: string; replica: string } {
  if (invariant === "INV-followers") {
    const host = world?.devices.find((d) => d.windows.some((w) => w.name === window))?.windows.find((w) => w.role === "host")?.name;
    return { server: host ? `host (${host})` : "host", replica: window ? `follower (${window})` : "follower" };
  }
  return { server: "server", replica: window ? `replica (${window})` : "replica" };
}
