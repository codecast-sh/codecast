// THE LEGACY CONVERGENCE SUITES' HARNESS: a thin adapter that keeps the
// vocabulary inboxConvergenceSim.test.ts and inboxMultiWindowSim.test.ts were
// written in (a SimServer, Replicas, Devices, SERVER_EVENTS) over the
// multiplayer sim's substrate (store/__tests__/sim/, spec
// docs/architecture/multiplayer-sim-harness.md, unit U14).
//
// SERVER: the sim backend (real Convex handlers over the fake db, through the
// router) seeded with one user's generated world. Canonical writes go through
// the real change-tracked db, so the sync log is the real one; the events
// another device or the daemon would cause are their real calls (a second
// window's store action, the daemon's updateAgentStatus, the empty-row GC).
// REPLICAS: a Replica is one SimWindow (its own store instance and engine
// closure), dispatching through the real binding. Its live feeds are held on
// the net and delivered only when the suite asks (receiveBase,
// receiveOverlay, receiveDecisions, catchUp, crawl), because the suites pick
// the order payloads arrive in. Server traffic (requests, responses, timers,
// scheduled jobs) settles after every step without moving the clock.
// DEVICES: a Device is one SimDevice (the engine's replication runtimes and
// the gesture bridge). Its window-to-window traffic waits on the net until
// the suite delivers it (deliver, drain), so it can interleave with feeds.
// CLOCK: the realm's virtual clock behind Date.now and performance.now.
import { expect } from "bun:test";
import { inboxEpoch, projectInbox, shouldShowInInbox, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, genWorld, makeRng, type GenWorld } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { makeChangeTrackedDb } from "@codecast/convex/convex/changeLog";
import { EMPTY_CONVERSATION_GRACE_MS } from "@codecast/convex/convex/cleanup";
import { SYNC_ACTIONS_RETENTION_MS } from "@codecast/convex/convex/syncLogPrune";
import { hashToken } from "@codecast/convex/convex/apiTokens";
import { makeSimBackend, type Principal, type SimBackend, type SimClient } from "@codecast/convex/convex/simBackend.testing";
import { useInboxStore, placeInboxRows } from "../inboxStore";
import {
  INBOX_COMPARE_TICK_MS,
  INBOX_HEAL_BUDGET,
  type InboxCompareOutcome,
  type InboxCompareState,
  type InboxDigestComparer,
  type InboxDigestComparerIO,
} from "../inboxDigestCompare";
import { BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS } from "../inboxOverlays";
import { declareViewNav } from "../viewNav";
import { setGestureChannelFactory } from "../gestureBridge";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { inboxCrawlWsKey, inboxFloorFlags, runInboxFloorStep } from "../../hooks/useSyncInboxSessions";
import { applyEntityIds, emptyIdsByCollection, scopeMetaKey } from "../../hooks/useSyncChangeFeed";
import { startInboxDigestCompare } from "../../hooks/useInboxDigestCompare";
import { LIST_INBOX_SESSIONS_ARGS } from "../../hooks/useLiveInboxSessions";
import * as realm from "./sim/realm";
import { T0, advance, attachRealm, installRealm, mono, now, resetClock, runInWindowSync, stream, uninstallRealm } from "./sim/realm";
import { Net, type ChannelFilter } from "./sim/net";
import { SimLabels } from "./sim/labels";
import { reportFailure, type DeliveryRecord } from "./sim/report";
import { makeActors, type Actors } from "./sim/actors";
import { tokenFor } from "./sim/world";
import { SimDevice } from "./sim/device";
import { windowOnline, type SimWindow, type SimWindowWorld } from "./sim/window";
import { placementOf } from "./sim/invariantReads";

export { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, makeRng };
export { INBOX_COMPARE_TICK_MS, INBOX_HEAL_BUDGET };

export const ME = "u".repeat(32);
export const CRAWL_KEY = syncMetaKey("sessions", inboxCrawlWsKey(ME));
const ME_SCOPE = `user:${ME}`;

// ── The virtual clock ───────────────────────────────────────────────────────
// It lives in the multiplayer sim's realm; re-exported here for these suites.
export { T0, advance, mono, now, resetClock };

/** beforeEach (and once per seed of a loop): a fresh realm on a reset clock. */
export function installSim(): void {
  uninstallSim();
  installRealm(0);
}

/** afterEach: restore every spy, the store facade and the gesture channel. */
export function uninstallSim(): void {
  uninstallRealm();
  setGestureChannelFactory(null);
}

// ── Channels ────────────────────────────────────────────────────────────────

// A channel's class never changes, and the net asks on every step: remember it.
function memoFilter(test: ChannelFilter): ChannelFilter {
  const seen = new Map<string, boolean>();
  return (c) => {
    let v = seen.get(c);
    if (v === undefined) seen.set(c, (v = test(c)));
    return v;
  };
}

// Server traffic: requests, responses, timers, scheduled jobs, actor verbs.
// Live feeds and a device's window-to-window traffic wait for the suite.
const isServerTraffic: ChannelFilter = memoFilter((c) => !c.startsWith("live:") && !c.startsWith("repl:") && !c.startsWith("bridge:"));

/**
 * One device's window-to-window traffic: its replication posts and gesture
 * bridge. Not memoized: a window that joins later adds channels to it.
 */
function deviceTraffic(sim: SimDevice): ChannelFilter {
  const bridge = `bridge:${sim.name}:`;
  return (c) => {
    if (c.startsWith(bridge)) return true;
    const [kind, from, to] = c.split(/[:>]/); // repl:<from>><to>
    return kind === "repl" && sim.windows.some((w) => w.name === from || w.name === to);
  };
}

// The feeds a host window mounts in the mine scope (sim/window.ts startHost).
const HOST_FEEDS = ["inbox", "liveness", "decisions", "heads"] as const;
type HostFeed = (typeof HOST_FEEDS)[number];

// Generous: a randomized seed runs a few hundred steps with real dispatch,
// floors and catch-ups. The budget catches a loop, not a slow seed.
const LEGACY_MAX_DELIVERIES = 200_000;
const LEGACY_MAX_WRITES = 50_000;

const worldSeeds = new WeakMap<GenWorld, number>();

// ── The server ──────────────────────────────────────────────────────────────

export class SimServer implements SimWindowWorld {
  readonly backend: SimBackend;
  readonly net: Net;
  readonly windows = new Map<string, SimWindow>();
  readonly labels = new SimLabels();
  readonly realm = realm;
  readonly actors: Actors;
  /** Catch-up runs when the suite asks (Replica.catchUp, crawl), never on its own at boot. */
  readonly holdCatchUp = true;
  /** The seededWorld seed this server was built from, when it was. */
  readonly seed: number | null;
  /** Every delivery of the run, for a failure's artifacts. */
  readonly events: DeliveryRecord[] = [];
  private readonly tracked: any;
  // Ids the next inserts into a table take: the suites name their rows.
  private readonly chosenIds = new Map<string, string[]>();
  private tokenSeeded: Promise<void> | null = null;
  private otherReplica: Replica | null = null;

  constructor(world: GenWorld) {
    this.seed = worldSeeds.get(world) ?? null;
    const tables: Record<string, any[]> = {
      users: [{ _id: ME, name: "Me", email: "me@example.com" }],
      messages: [],
      pending_messages: [],
      inbox_hides: [],
      api_tokens: [],
      ...world,
    };
    // Every Convex row has a creation time; a generated session was created when it started.
    for (const c of tables.conversations ?? []) c._creationTime ??= c.started_at ?? c.updated_at;
    this.backend = makeSimBackend({
      tables,
      now,
      rngFor: (seq) => stream(`call:${seq}`),
      mintId: (table, n) => this.chosenIds.get(table)?.shift() ?? convexIdFor(`${table}:${n}`),
      onSchedule: (job) => {
        this.net.enqueue("sched", { due: job.due, label: `sched ${job.name}`, producer: `sched ${job.name}`, run: () => this.backend.runScheduled(job) });
      },
    });
    this.net = new Net({
      rng: stream("net"),
      maxDeliveries: LEGACY_MAX_DELIVERIES,
      maxWrites: LEGACY_MAX_WRITES,
      writes: () => this.backend.writes(),
      now,
      advance,
      onOnline: (win) => windowOnline(this, win),
      onDeliver: ({ run: _run, ...d }) => void this.events.push(d),
    });
    attachRealm({ timers: this.net, serverCall: () => this.backend.activeCall() });
    this.tracked = makeChangeTrackedDb(this.backend.db);
    this.labels.register(ME, "me");
    this.actors = makeActors(this);
  }

  // -- What the actors and windows need of a world --

  start(): Promise<void> {
    return Promise.resolve();
  }
  idOf(label: string): string {
    return label === "me" ? ME : label;
  }
  row(label: string): Promise<any> {
    return this.backend.db.get(this.idOf(label));
  }
  clientAs(_user: string): SimClient {
    return this.backend.clientFor({ kind: "user", userId: ME });
  }
  daemonClientAs(user: string): SimClient {
    const p: Principal = { kind: "token", userId: ME, token: tokenFor(user) };
    return this.backend.clientFor(p);
  }
  /** A window's boot settles only what it started: server traffic and its own device's windows. */
  async settleBoot(w: SimWindow): Promise<void> {
    const mine = deviceTraffic(w.device);
    await this.net.drain({ horizonMs: 0, only: (c) => isServerTraffic(c) || mine(c) });
  }

  /** Runs every server delivery that is ready now (never a live feed, never a device's window traffic, never the clock). */
  flush(): Promise<void> {
    return this.net.drain({ horizonMs: 0, only: isServerTraffic });
  }

  // -- Reading the server --

  get conversations(): Array<Record<string, any>> {
    return this.backend.db._tables.conversations;
  }
  conv(id: string): Record<string, any> {
    const row = this.conversations.find((c) => c._id === id);
    if (!row) throw new Error(`no conversation ${id}`);
    return row;
  }
  /** The user scope's log head (the real sync_heads row). */
  head(): number {
    return (this.backend.db._tables.sync_heads ?? []).find((h: any) => h.scope_key === ME_SCOPE)?.position ?? 0;
  }
  /** The user scope's log past `from`, as the real syncLog:getRange answers the user. */
  range(from: number): Promise<{ actions: any[]; nextFrom: number; hasMore: boolean; resync?: boolean }> {
    return this.clientAs("me").query("syncLog:getRange", { scope_key: ME_SCOPE, from });
  }
  // The live window, exactly as a host subscribes to it.
  base(): Promise<{ sessions: Array<Record<string, any>> }> {
    return this.clientAs("me").query("conversations:listInboxSessions", LIST_INBOX_SESSIONS_ARGS);
  }
  overlay(): Promise<{ liveness: Record<string, any>; projection: any }> {
    return this.clientAs("me").query("conversations:sessionsLiveness", {});
  }

  // -- Writing the server (outside any window: another device, the daemon, a cron) --

  /** A canonical write: through the change-tracked db, so the sync log records it (or the churn exemption skips it). */
  async mutate(id: string, patch: Record<string, any>): Promise<void> {
    await this.tracked.patch(id, patch);
  }
  /** A new conversation under the id it names. */
  async insert(conv: Record<string, any>): Promise<void> {
    await this.insertRow("conversations", conv);
  }
  /** A hard delete. */
  async delete(id: string): Promise<void> {
    await this.tracked.delete(id);
  }
  /**
   * Retention: syncLogPrune.pruneSyncActions run at the instant whose
   * retention cutoff passes the timestamp of the last action at or below
   * `upTo`, so every action stamped at or before it is pruned (actions share
   * a timestamp when the clock stood still between them, and retention is by
   * time). The clock returns to where it was.
   */
  async retain(upTo: number): Promise<void> {
    let ts: number | null = null;
    let at = 0;
    for (const a of this.backend.db._tables.sync_actions ?? []) {
      if (a.scope_key === ME_SCOPE && a.position <= upTo && a.position > at) [at, ts] = [a.position, a.ts];
    }
    if (ts == null) return; // nothing left at or below upTo: retention already passed it
    const shift = ts + 1 + SYNC_ACTIONS_RETENTION_MS - now();
    advance(shift);
    try {
      await this.backend.runInternal("syncLogPrune:pruneSyncActions", {});
    } finally {
      advance(-shift);
    }
  }
  /** managed_sessions is not a tracked table: a fact flip reaches replicas only through the overlay. */
  async setAgent(id: string, patch: Record<string, any>): Promise<void> {
    const ms = (this.backend.db._tables.managed_sessions ?? []).find((m: any) => m.conversation_id === id);
    if (ms) {
      await this.tracked.patch(ms._id, patch);
      return;
    }
    await this.tracked.insert("managed_sessions", { user_id: ME, conversation_id: id, last_heartbeat: now(), agent_status: "idle", agent_status_updated_at: now(), ...patch });
  }
  /** The daemon's settle report (managedSessions.updateAgentStatus under the user's api token). */
  async daemonReports(id: string, status: "idle" | "working" | "done"): Promise<void> {
    await this.seedToken();
    if (!(this.backend.db._tables.managed_sessions ?? []).some((m: any) => m.conversation_id === id)) await this.setAgent(id, {});
    this.actors.daemon("me").settles(id, status);
    await this.flush();
  }
  /** The empty-conversation GC cron, once. */
  async gc(): Promise<void> {
    await this.backend.runInternal("cleanup:gcEmptyConversations", {});
    await this.flush();
  }
  /**
   * Another device of the same user: a host window of its own that acts
   * through the store, as a person would. Before each gesture it reads the
   * row it acts on through the byIds path (applyEntityIds), so it holds what
   * that person sees; its feeds and floor would add nothing a gesture reads.
   */
  async other(id: string): Promise<Replica> {
    const r = (this.otherReplica ??= new Replica("other", this, { seed: 0 }));
    await r.hydrate([id]);
    return r;
  }

  private async insertRow(table: string, row: Record<string, any>): Promise<void> {
    const { _id, ...doc } = row;
    if (_id) this.chosenIds.set(table, [...(this.chosenIds.get(table) ?? []), String(_id)]);
    await this.tracked.insert(table, Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined)));
  }

  private seedToken(): Promise<void> {
    return (this.tokenSeeded ??= hashToken(tokenFor("me")).then(async (token_hash) => {
      await this.backend.db.insert("api_tokens", { user_id: ME, token_hash, name: "sim daemon", created_at: now(), last_used_at: now() });
    }));
  }
}

// ── A replica ───────────────────────────────────────────────────────────────

export type TrackedEvent = { event: string; props: Record<string, unknown> };

export class Replica {
  events: TrackedEvent[] = [];
  lastOutcome: InboxCompareOutcome | null = null;
  device: Device | null = null;
  /** Zombie flags: a subscription that stopped pushing while the socket looks fine. */
  baseDead = false;
  overlayDead = false;
  private win: SimWindow | null = null;
  private sim: SimDevice | null = null;
  private booting: Promise<void> | null = null;
  private isOnline = true;
  private scheduled: Array<() => void> = [];
  private readonly rng: () => number;

  constructor(readonly name: string, readonly server: SimServer, opts: { seed?: number } = {}) {
    this.rng = makeRng(opts.seed ?? 1);
  }

  get role(): "host" | "follower" {
    return this.win?.role ?? "host";
  }
  get window(): SimWindow {
    if (!this.win) throw new Error(`replica ${this.name}: not booted yet (await one of its async methods first)`);
    return this.win;
  }
  get comparer(): InboxDigestComparer {
    return this.window.comparer!;
  }
  /** The window's store state, data fields only (what the legacy suites read and copy). */
  get state(): Record<string, any> {
    return Object.fromEntries(Object.entries(this.window.store.getState()).filter(([, v]) => typeof v !== "function"));
  }
  set state(next: Record<string, any>) {
    runInWindowSync(this.window, () => useInboxStore.setState(next as any));
  }
  /** The user scope's log cursor (0 when the window holds none). */
  get cursor(): number {
    return this.window.store.getState().syncMeta[scopeMetaKey(ME_SCOPE)]?.cursor ?? 0;
  }
  set cursor(position: number) {
    runInWindowSync(this.window, () => {
      const s = useInboxStore.getState();
      s.clearSyncMeta(scopeMetaKey(ME_SCOPE));
      s.recordSyncMeta(scopeMetaKey(ME_SCOPE), { cursor: position });
    });
  }
  get online(): boolean {
    return this.isOnline;
  }
  set online(on: boolean) {
    if (on === this.isOnline) return;
    this.isOnline = on;
    if (on) this.server.net.online(this.name);
    else this.server.net.offline(this.name);
  }

  // ── Boot ──

  /** Boots this replica as a standalone host the first time it is used. */
  async ready(): Promise<SimWindow> {
    await (this.booting ??= this.bootHost());
    return this.window;
  }
  get simDevice(): SimDevice {
    if (!this.sim) throw new Error(`replica ${this.name}: not booted yet`);
    return this.sim;
  }

  private async bootHost(): Promise<void> {
    const net = this.server.net;
    for (const feed of HOST_FEEDS) net.lag(this.channel(feed));
    this.sim = new SimDevice(this.server, { userId: ME }, this.name);
    await this.adopt(await this.sim.addWindow("host", { name: this.name }));
  }

  /** Joins `device` as a follower window: the host's chunked snapshot, then its stream. */
  async bootFollower(device: Device): Promise<void> {
    if (this.booting) throw new Error(`replica ${this.name}: already booted`);
    this.device = device;
    this.sim = device.sim;
    this.booting = device.sim.addWindow("follower", { name: this.name }).then((w) => this.adopt(w));
    await this.booting;
  }

  // The window's own comparer, with this replica's telemetry and heal queue.
  private async adopt(w: SimWindow): Promise<void> {
    this.win = w;
    await w.run(() => {
      w.comparer?.dispose();
      const io: Partial<InboxDigestComparerIO> = {
        // The replica names itself in its drift events; no real surface label fits.
        platform: `sim-${this.name}` as unknown as InboxDigestComparerIO["platform"],
        track: ((event: string, props: Record<string, unknown>) => void this.events.push({ event, props })) as InboxDigestComparerIO["track"],
        random: () => this.rng(),
        // A heal runs when the suite drains it (drainHeals), so the run stays deterministic.
        schedule: (fn) => {
          this.scheduled.push(fn);
          return () => {
            this.scheduled = this.scheduled.filter((f) => f !== fn);
          };
        },
        onError: (err) => {
          throw err;
        },
      };
      w.comparer = startInboxDigestCompare(w.client, () => () => {}, io).comparer;
    });
  }

  // ── Channels (host only: a follower holds no subscription) ──

  private channel(feed: HostFeed): string {
    return `live:${this.name}:${feed}`;
  }
  private feeds(): boolean {
    return this.isOnline && this.role === "host";
  }
  // Same-machine delivery outruns the network: whatever the windows already
  // posted to each other lands before the host's next server push.
  private async settleWindows(): Promise<void> {
    await this.device?.drain();
  }
  // One push of a held feed: the query runs now and its answer applies.
  private async pull(feed: HostFeed): Promise<void> {
    const w = await this.ready();
    const net = this.server.net;
    net.release(this.channel(feed));
    try {
      await w.refeed([feed]);
    } finally {
      net.lag(this.channel(feed));
    }
    await this.server.flush();
  }
  // A push of the base list or the overlay, unless that subscription is a zombie.
  private async receive(feed: "inbox" | "liveness", dead: boolean): Promise<void> {
    await this.ready();
    if (!this.feeds() || dead) return;
    await this.settleWindows();
    await this.pull(feed);
  }
  receiveBase = (): Promise<void> => this.receive("inbox", this.baseDead);
  receiveOverlay = (): Promise<void> => this.receive("liveness", this.overlayDead);
  async receiveDecisions(): Promise<void> {
    await this.ready();
    if (!this.feeds()) return;
    await this.pull("decisions");
  }
  /** The sync-log catch-up (useSyncChangeFeed's runner), then the floor step it wakes. */
  async catchUp(): Promise<void> {
    const w = await this.ready();
    if (!this.feeds()) return;
    await this.settleWindows();
    await w.catchUp();
    await this.server.flush();
  }
  /**
   * The completeness floor (runInboxFloorStep): cut once per cold or
   * resynced cache, after the log stamped the scope. A replica whose log is
   * not stamped yet catches up first, which cuts the floor when it settles.
   */
  async crawl(): Promise<void> {
    const w = await this.ready();
    if (!this.feeds()) return;
    const flags = runInWindowSync(w, () => inboxFloorFlags(useInboxStore.getState(), ME));
    if (!flags.logStamped) {
      await this.catchUp();
      return;
    }
    await this.settleWindows();
    await w.run(() => runInboxFloorStep(w.client, inboxFloorFlags(useInboxStore.getState(), ME)));
    await this.server.flush();
  }
  async receiveAll(): Promise<void> {
    await this.receiveBase();
    await this.receiveOverlay();
    await this.receiveDecisions();
    await this.catchUp();
  }

  // ── Gestures (the real store actions; the window's dispatch reaches the server) ──

  /**
   * One turn of this window, then the server traffic it started. The turn
   * ends before that traffic runs, so `fn` starts server work and never
   * waits on it (see hydrate).
   */
  async withStore<T>(fn: () => Promise<T> | T): Promise<T> {
    const w = await this.ready();
    const out = await w.run(fn);
    await this.server.flush();
    return out;
  }
  pin(id: string): Promise<void> {
    return this.withStore(() => useInboxStore.getState().pinSession(id));
  }
  kill(id: string): Promise<void> {
    return this.withStore(() => useInboxStore.getState().killSession(id));
  }
  stash(id: string): Promise<void> {
    return this.withStore(() => useInboxStore.getState().stashSession(id));
  }
  restore(id: string): Promise<void> {
    return this.withStore(() => useInboxStore.getState().restoreSession(id));
  }
  revive(id: string): Promise<void> {
    return this.withStore(() => useInboxStore.getState().markBlockedReviveRequested([id]));
  }
  setQueued(id: string, queued: boolean): Promise<void> {
    return this.withStore(() => useInboxStore.getState().setSessionHasQueuedMessages(id, queued));
  }
  async setQueuedAll(queued: boolean): Promise<void> {
    await this.ready();
    const ids = [...(this.state.sessionsWithQueuedMessages as Set<string>)];
    for (const id of ids) await this.setQueued(id, queued);
  }
  focus(id: string | null): Promise<void> {
    return this.withStore(() => {
      declareViewNav("gesture");
      useInboxStore.setState({ currentSessionId: id } as any);
    });
  }
  /** Reads these sessions through the byIds path (applyEntityIds), as catch-up does. */
  async hydrate(ids: string[]): Promise<void> {
    const w = await this.ready();
    let applied: Promise<unknown> = Promise.resolve();
    await w.run(() => {
      applied = applyEntityIds(w.client, { ...emptyIdsByCollection(), sessions: ids });
    });
    await this.server.flush();
    await applied;
  }
  /** Lets the server traffic this window started land (a probe's answer, a heal's rows). */
  flush(): Promise<void> {
    return this.server.flush();
  }

  // ── The compare loop ──

  compareState(): InboxCompareState {
    return this.window.store.getState() as unknown as InboxCompareState;
  }
  tick(): InboxCompareOutcome {
    const comparer = this.comparer;
    const outcome = runInWindowSync(this.window, () => comparer.tick(useInboxStore.getState() as any));
    this.lastOutcome = outcome;
    return outcome;
  }
  /** Run whatever the comparer scheduled (a jittered heal) to completion. */
  async drainHeals(): Promise<number> {
    const w = await this.ready();
    let ran = 0;
    while (this.scheduled.length) {
      const fn = this.scheduled.shift()!;
      await w.run(fn);
      await this.server.flush();
      ran++;
    }
    return ran;
  }
  eventsNamed(name: string): TrackedEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  // ── The rendered projection, from the chokepoint every surface uses ──

  placed() {
    return runInWindowSync(this.window, () => placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: now() }));
  }
  membership(): string[] {
    return [...this.placed().placements.keys()].sort();
  }
  /** Rows this window renders in an active bucket: what its user can pin, kill, stash. */
  visibleIds(): string[] {
    return [...this.placed().placements].filter(([, p]) => p.bucket !== "dismissed" && p.bucket !== "stashed").map(([id]) => id).sort();
  }
  /** Rows this window renders as hidden (Dismissed / Stashed): what its user can restore. */
  hiddenIds(): string[] {
    return [...this.placed().placements].filter(([, p]) => p.bucket === "dismissed" || p.bucket === "stashed").map(([id]) => id).sort();
  }
  /** Whether this window shows `id` in an active bucket right now. */
  shows(id: string): boolean {
    const p = this.placed().placements.get(id);
    return !!p && p.bucket !== "dismissed" && p.bucket !== "stashed";
  }
  placementsSnapshot(): Record<string, string> {
    return Object.fromEntries([...this.placed().placements].map(([id, p]) => [id, placementOf(p)]));
  }
}

// ── A device: one host window plus followers, and the traffic between them ─

export class Device {
  readonly windows: Replica[] = [];
  readonly sim: SimDevice;
  private readonly mine: ChannelFilter;

  /** `host` is a booted replica (bootReplica); its machine becomes this device. */
  constructor(readonly name: string, readonly host: Replica) {
    this.sim = host.simDevice;
    this.mine = deviceTraffic(this.sim);
    host.device = this;
    this.windows.push(host);
  }
  get followers(): Replica[] {
    return this.windows.filter((w) => w.role === "follower");
  }
  async addFollower(follower: Replica): Promise<void> {
    this.windows.push(follower);
    await follower.bootFollower(this);
  }
  /** Window-to-window deliveries waiting on this device. */
  pendingDeliveries(): number {
    return this.host.server.net.queued(this.mine);
  }
  /** Deliver the next `n` of them in order (all by default), each followed by the server traffic it caused. */
  async deliver(n = Infinity): Promise<number> {
    const server = this.host.server;
    let delivered = 0;
    while (delivered < n && (await server.net.step(this.mine))) {
      delivered++;
      await server.flush();
    }
    return delivered;
  }
  /** Drain until nothing is queued, including what deliveries themselves enqueue. */
  async drain(): Promise<void> {
    await this.deliver();
  }
}

// ── The canonical projection ────────────────────────────────────────────────

// Computed directly: the shared module over the server's conversations with
// the overlay's facts merged on (the same adapter every replica applies), at
// the payload's epoch.
export async function canonicalProjection(server: SimServer) {
  const { liveness, projection } = await server.overlay();
  const rows: ProjectableInboxRow[] = [];
  const asking = new Set<string>();
  for (const c of server.conversations) {
    const lv: any = liveness[c._id];
    const row: any = { ...c };
    if (lv) {
      for (const f of ["agent_status", "is_idle", "is_unresponsive", "awaiting_input", "message_count", "updated_at", "last_turn_allows_park"]) {
        if (lv[f] !== undefined) row[f] = lv[f];
      }
      if (lv.asking) asking.add(c._id);
    }
    rows.push(row);
  }
  const direct = projectInbox(rows, projection.epoch, { asking: (id) => asking.has(id) });
  expect(direct.set_digest).toBe(projection.set_digest!);
  return { direct, projection, liveness };
}

// One quiet compare tick: past the quiescence window, then (unless the
// overlay is dead) a fresh overlay at the instant of the tick so the server's
// execution clock and the replica's evaluation clock coincide.
export async function quietTick(r: Replica, opts: { overlay?: boolean } = {}): Promise<InboxCompareOutcome> {
  advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
  if (opts.overlay !== false) await r.receiveOverlay();
  return r.tick();
}

// Quiescence: everyone online, every channel delivered, every window's
// queues drained, the clock past every overlay bound and the quiescence
// window, then the proof: every HOST matches the canonical projection through
// the compare loop (heals allowed within one budget), and every FOLLOWER
// renders byte for byte what its host renders.
export async function settleAndAssertConverged(server: SimServer, replicas: Replica[]): Promise<string[]> {
  const hosts = replicas.filter((r) => r.role === "host");
  const devices = [...new Set(replicas.map((r) => r.device).filter((d): d is Device => !!d))];
  for (const r of replicas) {
    r.online = true;
    r.baseDead = false;
    r.overlayDead = false;
  }
  await server.flush();
  // Every window's queued messages land, then the local overlays expire: the
  // revive TTL and the triage lock settle (a mut delivered after the clock
  // moved would plant a fresh lock and keep the compare off its short circuit).
  for (const r of replicas) {
    await r.setQueuedAll(false);
    await r.focus(null);
  }
  for (const d of devices) await d.drain();
  advance(Math.max(BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS) + GEN_MIN);
  await server.flush();
  for (const r of hosts) await r.receiveAll();
  for (const d of devices) await d.drain();
  // Two quiet ticks with no row applies, then a fresh overlay for everyone
  // (the overlay is not sync activity) and the proof at THAT instant: the
  // server executed at this clock, so the replica's trust decay and render
  // epoch evaluate at the same time the stamps were computed.
  advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
  for (const r of hosts) await r.receiveOverlay();
  for (const d of devices) await d.drain();

  const healedReplicas: string[] = [];
  const canonicalPlacements: Record<string, string> = {};
  let direct!: Awaited<ReturnType<typeof canonicalProjection>>["direct"];
  let projection!: Awaited<ReturnType<typeof canonicalProjection>>["projection"];
  const recanonicalize = async () => {
    ({ direct, projection } = await canonicalProjection(server));
    for (const id of Object.keys(canonicalPlacements)) delete canonicalPlacements[id];
    for (const [id, p] of direct.placements) canonicalPlacements[id] = `${p.bucket}/${p.work_state}/${p.below_fold ? 1 : 0}`;
  };

  for (const r of hosts) {
    // Quiescence is per window: another host's heal a moment ago is sync
    // activity on the shared clock, so let it pass, then take the canonical
    // projection at the instant of this host's payload.
    advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
    await r.receiveOverlay();
    await recanonicalize();
    let outcome = r.tick();
    // The sync channels alone are not the whole proof: the anti-entropy loop
    // is. A replica the channels left diverged must converge through the
    // compare's own heal, within ONE budget: the persistence rule (a second
    // compare at a distinct payload epoch), then the targeted heal, then clean.
    let heals = 0;
    if (outcome.kind === "diff" && process.env.SIM_TRACE) {
      console.log(`[sim:trace] ${r.name} needs a heal: ${server.labels.relabel(JSON.stringify({ diff: outcome.diff, detail: driftDetail(server, r, driftIds(outcome.diff)) }, null, 1))}`);
    }
    while (outcome.kind === "diff" && heals < INBOX_HEAL_BUDGET) {
      advance(GEN_MIN);
      await r.receiveOverlay();
      r.tick();
      heals += await r.drainHeals();
      advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
      await r.receiveOverlay();
      outcome = r.tick();
    }
    if (heals > 0) healedReplicas.push(`${r.name}:${heals}`);
    if (outcome.kind === "diff") {
      const ids = driftIds(outcome.diff);
      fail(server, r, ids[0], {
        id: "legacy.diverged",
        meaning: "every host matches the canonical projection at quiescence, through the compare loop's heals within one budget",
        message: `replica ${r.name} diverged at quiescence after ${heals} heal(s): ${JSON.stringify({ diff: outcome.diff, detail: driftDetail(server, r, ids) }, null, 1)}`,
      });
    }
    if (heals > 0) await recanonicalize();
    expect({ replica: r.name, outcome }).toEqual({ replica: r.name, outcome: { kind: "clean", epoch: projection.epoch, short_circuit: true, payload_age_ms: expect.any(Number) } });
    assertPlacements(server, r, r.placementsSnapshot(), canonicalPlacements, "canonical");
    const placed = r.placed();
    expect<{ replica: string; digest: string | null }>({ replica: r.name, digest: placed.set_digest }).toEqual({ replica: r.name, digest: projection.set_digest });
    expect({ replica: r.name, tally: placed.tally }).toEqual({ replica: r.name, tally: projection.tally });
    expect(r.membership()).toEqual([...direct.placements.keys()].sort());
  }
  // Host against host, byte for byte: every host on the final payload.
  for (const r of hosts) await r.receiveOverlay();
  for (const d of devices) await d.drain();
  for (let i = 1; i < hosts.length; i++) {
    assertPlacements(server, hosts[i], hosts[i].placementsSnapshot(), hosts[0].placementsSnapshot(), hosts[0].name);
    expect(hosts[i].placed().set_digest).toBe(hosts[0].placed().set_digest);
  }
  // Every follower renders exactly what its host renders: a heal on the
  // host reached it through replication, so drain once more first.
  for (const d of devices) await d.drain();
  for (const d of devices) {
    for (const f of d.followers) {
      assertPlacements(server, f, f.placementsSnapshot(), d.host.placementsSnapshot(), d.host.name);
      expect({ window: f.name, digest: f.placed().set_digest }).toEqual({ window: f.name, digest: d.host.placed().set_digest });
    }
  }
  return healedReplicas;
}

// ── Failure reports (sim/report.ts) ─────────────────────────────────────────

const driftIds = (diff: { missing: string[]; extra: string[]; bucket_deltas: string[]; fold_deltas: string[] }) => [
  ...diff.missing, ...diff.extra, ...diff.bucket_deltas, ...diff.fold_deltas,
];

// The fields a placement reads, so a report shows the inputs that disagree.
const PLACEMENT_FIELDS = /status|agent_status|is_idle|updated_at|message_count|has_pending|awaiting|unresponsive|last_turn|settle_verdict|dormant|inbox_|is_pinned|is_deferred|started_at/;
const pick = (row: any): Record<string, unknown> | null => row && Object.fromEntries(Object.entries(row).filter(([k]) => PLACEMENT_FIELDS.test(k)));
const pendingFor = (r: Replica, id: string) => Object.entries(r.state.pending as Record<string, unknown>).filter(([k]) => k.includes(id));

function driftDetail(server: SimServer, r: Replica, ids: string[]) {
  return ids.map((id) => ({
    id,
    server: pick(server.conversations.find((c) => c._id === id)),
    stamp: (r.state.sessionsProjection as any).mine?.stamps?.[id] ?? null,
    replica: pick((r.state.sessions as any)[id]),
    pending: pendingFor(r, id),
  }));
}

// A placement mismatch names the rows and shows both sides' inputs, so a
// failing seed reads as a cause, not as a diff of two digests.
function assertPlacements(server: SimServer, r: Replica, got: Record<string, string>, want: Record<string, string>, against: string): void {
  const ids = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((id) => got[id] !== want[id]);
  if (ids.length === 0) return;
  const detail = ids.map((id) => ({
    id, got: got[id] ?? null, want: want[id] ?? null,
    server: pick(server.conversations.find((c) => c._id === id)),
    replica: pick((r.state.sessions as any)[id]),
    pending: pendingFor(r, id),
  }));
  fail(server, r, ids[0], {
    id: "legacy.placements",
    meaning: `every window places each row (bucket/work state/fold) as ${against === "canonical" ? "the canonical projection" : `its reference window ${against}`} does`,
    message: `${r.name} places ${ids.length} row(s) unlike ${against}: ${JSON.stringify(detail, null, 1)}`,
  });
}

// One failure block through the sim's report: the first row's server and
// replica fields side by side, the last deliveries, and the artifacts.
function fail(server: SimServer, r: Replica, rowId: string | undefined, check: { id: string; meaning: string; message: string }): never {
  const seed = server.seed ?? 0;
  const serverRow = rowId ? server.conversations.find((c) => c._id === rowId) ?? null : null;
  const replicaRow = rowId ? (r.state.sessions as any)[rowId] ?? null : null;
  reportFailure(
    {
      scenario: `legacy-${r.name}`,
      mode: "scripted",
      seed,
      step: "settleAndAssertConverged",
      delivery: server.net.deliveries,
      invariant: { id: check.id, meaning: check.meaning },
      message: check.message,
      window: { name: r.name, principal: ME, scope: "mine" },
      row: rowId ? { table: "conversations", id: rowId, server: pick(serverRow), replica: pick(replicaRow) } : undefined,
      ring: server.net.ring,
      order: server.net.orderSoFar(),
      labels: server.labels,
      t0: T0,
      replay: [`SIM_SEEDS=${seed} SIM_TRACE=1 bun test store/__tests__/inboxConvergenceSim.test.ts store/__tests__/inboxMultiWindowSim.test.ts`],
    },
    { events: server.events, world: { seed, conversations: server.conversations.length }, final: { replica: r.name, placements: r.placementsSnapshot() } },
  );
}

// ── Server-side events another device or the daemon would cause ────────────

export function newConversation(tag: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    _id: convexIdFor(tag),
    user_id: ME,
    status: "active",
    updated_at: now(),
    started_at: now() - GEN_MIN,
    message_count: 1,
    last_message_role: "user",
    title: `Session ${tag}`,
    ...over,
  };
}

export type ServerEvent = (server: SimServer, rng: () => number, step: number) => Promise<void>;

/** A random row the window's user can see and act on (null when it shows none). */
export const pickShown = (w: Replica, rng: () => number): string | null => {
  const ids = w.visibleIds();
  return ids.length ? ids[Math.floor(rng() * ids.length)] : null;
};
/** A random row the window's user can restore (null when none is hidden). */
export const pickHidden = (w: Replica, rng: () => number): string | null => {
  const ids = w.hiddenIds();
  return ids.length ? ids[Math.floor(rng() * ids.length)] : null;
};

// A server-side event lands on a row the server lists: shouldShowInInbox drops
// a completed blank or a noise title, so nothing (another device, the daemon)
// acts on one either.
export const memberIds = (server: SimServer, rng: () => number): string | null => {
  const ids = server.conversations.filter((c) => !c.is_subagent && !c.inbox_killed_at && shouldShowInInbox(c as any)).map((c) => c._id);
  return ids.length ? ids[Math.floor(rng() * ids.length)] : null;
};

export const SERVER_EVENTS: Record<string, ServerEvent> = {
  newSession: async (s, _rng, step) => {
    const c = newConversation(`new${step}`);
    await s.insert(c);
    await s.setAgent(c._id, { agent_status: "working", last_heartbeat: now(), agent_status_updated_at: now() });
  },
  agentSettles: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await s.daemonReports(id, "idle");
  },
  agentDeclaresDone: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await s.daemonReports(id, "done");
  },
  agentStarts: async (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    await s.daemonReports(id, "working");
    // The turn's transcript flush: churn fields only, so the sync log skips it.
    await s.mutate(id, { updated_at: now(), message_count: (s.conv(id).message_count ?? 0) + 1 });
  },
  daemonDies: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await s.setAgent(id, { last_heartbeat: now() - GEN_HOUR });
  },
  otherDevicePins: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await (await s.other(id)).pin(id);
  },
  otherDeviceDismisses: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await (await s.other(id)).kill(id);
  },
  otherDeviceStashes: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await (await s.other(id)).stash(id);
  },
  otherDeviceRestores: async (s, rng) => {
    const hidden = s.conversations.filter((c) => !c.is_subagent && (c.inbox_dismissed_at || c.inbox_stashed_at));
    if (!hidden.length) return;
    const c = hidden[Math.floor(rng() * hidden.length)];
    await (await s.other(c._id)).restore(c._id);
  },
  gcDeletesBlank: async (s, rng, step) => {
    // The empty-conversation GC: a blank row past the grace window is
    // hard-deleted, a younger one is kept; a replica that cached it learns
    // only through the log's delete (authorized absence).
    const reapable = rng() < 0.7;
    await s.insert(newConversation(`blank${step}`, {
      message_count: 0,
      last_message_role: undefined,
      started_at: now() - GEN_DAY,
      _creationTime: reapable ? now() - EMPTY_CONVERSATION_GRACE_MS - GEN_MIN : now(),
    }));
    await s.gc();
  },
  triggerArms: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await s.mutate(id, { armed_trigger_kind: s.conv(id).armed_trigger_kind === "standing" ? "none" : "standing" });
  },
  decisionQueued: async (s, rng, step) => {
    const id = memberIds(s, rng);
    if (!id) return;
    await s.backend.db.insert("session_decisions", { user_id: ME, conversation_id: id, status: "pending", created_at: now(), title: `decision ${step}` });
  },
  decisionAnswered: async (s) => {
    const open = (s.backend.db._tables.session_decisions ?? []).find((d: any) => d.status === "pending");
    if (open) await s.backend.db.patch(open._id, { status: "answered" });
  },
  userParks: async (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    await s.mutate(id, { inbox_rest: rng() < 0.5 ? "dormant" : rng() < 0.5 ? "done" : "needs_input", inbox_rest_at: now() });
  },
  apiErrorBanner: async (s, rng) => {
    const id = memberIds(s, rng);
    if (id) await s.mutate(id, { pending_api_error: !s.conv(id).pending_api_error });
  },
};

// ── Fixtures ────────────────────────────────────────────────────────────────

export function seededWorld(seed: number, n = 45): GenWorld {
  const world = genWorld(seed, n, inboxEpoch(now()), ME);
  worldSeeds.set(world, seed);
  return world;
}

/** A standalone host replica: booted, its floor cut, every feed delivered once. */
export async function bootReplica(server: SimServer, name: string, seed: number): Promise<Replica> {
  const r = new Replica(name, server, { seed });
  await r.crawl();
  await r.receiveAll();
  return r;
}

/** A device whose host booted from the server and whose followers booted from the host. */
export async function bootDevice(server: SimServer, name: string, seed: number, followers = 1): Promise<Device> {
  const host = await bootReplica(server, `${name}-host`, seed);
  const device = new Device(name, host);
  for (let i = 0; i < followers; i++) {
    const f = new Replica(`${name}-w${i + 1}`, server, { seed: seed + 10 * (i + 1) });
    await device.addFollower(f);
  }
  return device;
}
