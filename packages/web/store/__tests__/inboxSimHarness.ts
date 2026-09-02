// THE MULTI-REPLICA SIMULATION HARNESS — the eventual-consistency proof's
// moving parts, shared by the convergence simulations
// (docs/architecture/sync-convergence.md, "Validation plan": Simulation).
//
// SERVER: the real Convex compute functions over an in-memory db (the live
// window, the liveness overlay, the byIds hydration, the completeness floor)
// plus a sync log the sim appends to on every canonical write.
// REPLICAS: snapshots of the real web store, swapped into the singleton one
// at a time, fed through the real appliers (syncTable, the overlay applier,
// the log catch-up, the floor watermark) and driven with the real gestures
// (pin, kill, stash, revive, queued send), each with its own log cursor,
// online flag and digest comparer.
// DEVICES: a device is one origin — a HOST window that owns the feeders and
// zero or more FOLLOWER windows that hold no subscription of their own. The
// windows talk over the two production channels, modelled as in-order queues
// the schedule drains: replication (the host's write-through tee broadcasts
// its writes; a follower offers its own action writes back as muts, which the
// host applies as sync writes and re-broadcasts) and the gesture bridge (a
// triage gesture announces itself to every sibling window, which plants the
// same field locks). Both run through the production code: the engine's
// patch extractor, the store's replication applier, applyGestureBridge.
// CLOCK: one virtual clock behind Date.now AND performance.now, so the
// projection epoch, the overlay receipt clock, the overlay bounds and the
// quiescence gate all move together and every run is replayable.
import { expect, spyOn } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
} from "@codecast/convex/convex/conversations";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { inboxEpoch, projectInbox, shouldShowInInbox, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, genWorld, makeRng, type GenWorld } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { extractReplicationUpdates, snapshotEntries, type ReplicationUpdate } from "@platform/engine";
import {
  useInboxStore,
  placeInboxRows,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
} from "../inboxStore";
import {
  INBOX_COMPARE_TICK_MS,
  INBOX_HEAL_BUDGET,
  createInboxDigestComparer,
  type InboxCompareOutcome,
  type InboxCompareState,
  type InboxDigestComparer,
} from "../inboxDigestCompare";
import { BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS } from "../inboxOverlays";
import { __resetSyncActivityForTests, __setSyncActivityForTests, lastSyncApplyMono, syncApplySeq } from "../syncActivity";
import { declareViewNav } from "../viewNav";
import { applyUpdatesToStore, buildMutUpdates } from "../syncReplication";
import { isReplicatedCollectionKey, REPLICATED_STORE_KEYS } from "../clientSyncRegistry";
import { setGestureChannelFactory, type GestureMessage } from "../gestureBridge";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { inboxCrawlWsKey } from "../../hooks/useSyncInboxSessions";
import { LIST_INBOX_SESSIONS_ARGS } from "../../hooks/useLiveInboxSessions";

export { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, makeRng };
export { INBOX_COMPARE_TICK_MS, INBOX_HEAL_BUDGET };

export const ME = "u".repeat(32);
export const CRAWL_KEY = syncMetaKey("sessions", inboxCrawlWsKey(ME));
export const T0 = inboxEpoch(1_800_000_000_000) + 25_000;
const MONO0 = 10_000_000;

// ── The virtual clock ───────────────────────────────────────────────────────

let vnow = T0;
export const now = (): number => vnow;
export const mono = (): number => MONO0 + (vnow - T0);
export function advance(ms: number): void {
  vnow += ms;
}
export function resetClock(): void {
  vnow = T0;
}

let nowSpy: ReturnType<typeof spyOn> | null = null;
let perfSpy: ReturnType<typeof spyOn> | null = null;

/** beforeEach: pin the clock, reset every module-scope cache the store keeps. */
export function installSim(): void {
  vnow = T0;
  nowSpy = spyOn(Date, "now").mockImplementation(() => vnow);
  perfSpy = spyOn(performance, "now").mockImplementation(() => mono());
  __resetSyncActivityForTests();
  __resetInboxPlacementCacheForTests();
  installTees();
}

/** afterEach: restore the clock and leave no replica in the singleton store. */
export function uninstallSim(): void {
  nowSpy?.mockRestore();
  perfSpy?.mockRestore();
  nowSpy = null;
  perfSpy = null;
  uninstallTees();
  // The singleton store outlives a test file: a future-epoch projection slot
  // would age every later test's rows out of the working set.
  useInboxStore.setState(freshReplicaState() as any);
  __resetInboxPlacementCacheForTests();
}

// ── The server ──────────────────────────────────────────────────────────────

export type LogEntry = { position: number; entity_id: string };

export class SimServer {
  db: any;
  log: LogEntry[] = [];
  private position = 0;
  /** Retention: positions at or below this are gone from the log. */
  floor = 0;
  constructor(world: GenWorld) {
    this.db = makeFakeDb({
      users: [{ _id: ME, name: "Me", email: "me@example.com" }],
      messages: [],
      ...world,
    });
  }
  get conversations(): Array<Record<string, any>> {
    return this.db._tables.conversations;
  }
  conv(id: string): Record<string, any> {
    const row = this.conversations.find((c) => c._id === id);
    if (!row) throw new Error(`no conversation ${id}`);
    return row;
  }
  head(): number {
    return this.position;
  }
  // A canonical write to a tracked table: the row moves and the log records it.
  mutate(id: string, patch: Record<string, any>): number {
    Object.assign(this.conv(id), patch);
    this.log.push({ position: ++this.position, entity_id: id });
    return this.position;
  }
  insert(conv: Record<string, any>): void {
    this.conversations.push(conv);
    this.log.push({ position: ++this.position, entity_id: conv._id });
  }
  // A hard delete (the empty-conversation GC): the row is gone, the log
  // records the delete; a replica that asks by id gets nothing back.
  delete(id: string): void {
    const i = this.conversations.findIndex((c) => c._id === id);
    if (i >= 0) this.conversations.splice(i, 1);
    this.log.push({ position: ++this.position, entity_id: id });
  }
  // Retention: everything at or below `upTo` leaves the log. A replica whose
  // cursor is below the floor cannot be proven from the log any more.
  retain(upTo: number): void {
    this.floor = Math.max(this.floor, Math.min(upTo, this.position));
    this.log = this.log.filter((e) => e.position > this.floor);
  }
  // managed_sessions is NOT a tracked table: a fact flip reaches replicas only
  // through the overlay.
  setAgent(id: string, patch: Record<string, any>): void {
    let ms = this.db._tables.managed_sessions.find((m: any) => m.conversation_id === id);
    if (!ms) {
      ms = { _id: `ms_${id.slice(0, 8)}`, user_id: ME, conversation_id: id, last_heartbeat: vnow, agent_status: "idle", agent_status_updated_at: vnow };
      this.db._tables.managed_sessions.push(ms);
    }
    Object.assign(ms, patch);
  }
  // The live window, exactly as the subscription requests it.
  async base() {
    return computeInboxSessions({ db: this.db }, ME as any, {
      show_all: LIST_INBOX_SESSIONS_ARGS.show_all,
      includeLiveness: LIST_INBOX_SESSIONS_ARGS.include_liveness,
      fastFieldsInOverlay: LIST_INBOX_SESSIONS_ARGS.fast_fields_in_overlay,
    });
  }
  async overlay() {
    return computeSessionsLiveness({ db: this.db }, ME as any);
  }
  async byIds(ids: string[]) {
    return (await collectInboxSessionsByIds({ db: this.db }, ME as any, ids)).sessions;
  }
  async crawl(since: number): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const res: any = await collectInboxSessionsPaginated({ db: this.db }, ME as any, { since, paginationOpts: { numItems: 40, cursor } });
      all.push(...(res.page ?? []));
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    return all;
  }
  range(from: number): { ids: string[]; upTo: number; resync: boolean } {
    if (from < this.floor) return { ids: [], upTo: this.position, resync: true };
    const entries = this.log.filter((e) => e.position > from);
    return { ids: [...new Set(entries.map((e) => e.entity_id))], upTo: this.position, resync: false };
  }
}

// ── A replica ───────────────────────────────────────────────────────────────

// The store keys a replica owns. Everything the projection, the overlays and
// the compare read, plus the row twins the gestures write.
export const REPLICA_KEYS = [
  "sessions", "conversations", "messages", "pagination", "sessionsProjection", "pending",
  "pendingMessages", "pendingSessionCreates", "sessionsWithQueuedMessages", "blockedReviveRequestedAt",
  "currentSessionId", "sessionDecisions", "questionResolutions", "currentUser", "clientState",
  "syncMeta", "syncProgress", "liveInboxIds", "liveInboxIdList", "teamInboxIds",
] as const;

export function freshReplicaState(): Record<string, unknown> {
  return {
    sessions: {}, conversations: {}, messages: {}, pagination: {}, sessionsProjection: {}, pending: {},
    pendingMessages: {}, pendingSessionCreates: {}, sessionsWithQueuedMessages: new Set(), blockedReviveRequestedAt: {},
    currentSessionId: null, sessionDecisions: {}, questionResolutions: {}, currentUser: { _id: ME },
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: false } },
    syncMeta: {}, syncProgress: {}, liveInboxIds: new Set(), liveInboxIdList: [], teamInboxIds: new Set(),
  };
}

export type TrackedEvent = { event: string; props: Record<string, unknown> };

// The window whose state is loaded into the singleton store right now: the
// tees below attribute every captured write to it.
let current: Replica | null = null;
let teePatches: any[] = [];
let teeState: any = null;
let teeIsAction = false;

const isReplicated = (key: string) => (REPLICATED_STORE_KEYS as readonly string[]).includes(key);

function installTees(): void {
  const s = useInboxStore.getState() as any;
  // The host's write-through tee (every write) and the follower's action tee
  // (its own optimistic writes only), routed by the loaded window's role.
  s._setIDBWrite((patches: any[], state: any) => {
    if (current?.role !== "host") return;
    teePatches.push(...patches);
    teeState = state;
  });
  s._setActionTee((_name: string, patches: any[], state: any) => {
    if (current?.role !== "follower") return;
    teePatches.push(...patches);
    teeState = state;
    teeIsAction = true;
  });
  // The gesture bridge: a fake BroadcastChannel whose posts land on the
  // loaded window's device queue for every sibling window.
  setGestureChannelFactory(() => ({
    postMessage(data: any) {
      const { v: _v, source: _s, userId: _u, ...msg } = data ?? {};
      current?.device?.gesture(msg as GestureMessage, current);
    },
    addEventListener() {},
    removeEventListener() {},
    close() {},
  }) as unknown as BroadcastChannel);
}

function uninstallTees(): void {
  const s = useInboxStore.getState() as any;
  s._setIDBWrite(null);
  s._setActionTee(null);
  setGestureChannelFactory(null);
  current = null;
  teePatches = [];
  teeState = null;
  teeIsAction = false;
}

export class Replica {
  state: Record<string, unknown> = freshReplicaState();
  cursor = 0;
  online = true;
  /** Zombie flags: a subscription that stopped pushing while the socket looks fine. */
  baseDead = false;
  overlayDead = false;
  events: TrackedEvent[] = [];
  comparer: InboxDigestComparer;
  lastOutcome: InboxCompareOutcome | null = null;
  role: "host" | "follower" = "host";
  device: Device | null = null;
  /** This window's sync activity clock (a module singleton in the store; one per window here). */
  private activity = { lastApplyMono: Number.NEGATIVE_INFINITY, applySeq: 0 };
  /** Ids this replica pruned by its own hand (excludes planted). */
  private scheduled: Array<() => void> = [];

  constructor(readonly name: string, readonly server: SimServer, opts: { seed?: number } = {}) {
    const rng = makeRng(opts.seed ?? 1);
    this.comparer = createInboxDigestComparer({
      platform: `sim-${name}`,
      track: (event, props) => this.events.push({ event, props }),
      crawlMetaKeyFor: (meId) => (meId ? syncMetaKey("sessions", inboxCrawlWsKey(meId)) : null),
      // The heal IO is the real recovery path: byIds hydration through
      // syncTable, one overlay probe through the one applier. Scheduled work
      // runs synchronously at the next drain so the sim stays deterministic.
      fetchByIds: async (ids) => this.withStore(async () => {
        const rows = await server.byIds(ids);
        useInboxStore.getState().applyHealedSessions(ids, rows as unknown as InboxSession[]);
      }),
      probeOverlay: async () => this.withStore(async () => {
        useInboxStore.getState().applyInboxLivenessPayload("mine", await server.overlay());
      }),
      now: () => vnow,
      nowMono: mono,
      random: () => rng(),
      schedule: (fn) => {
        this.scheduled.push(fn);
        return () => { this.scheduled = this.scheduled.filter((f) => f !== fn); };
      },
      onError: (err) => { throw err; },
    });
  }

  // Swap this replica into the singleton store for one operation.
  load(): void {
    __resetInboxPlacementCacheForTests();
    declareViewNav("gesture");
    useInboxStore.setState(this.state as any);
    __setSyncActivityForTests(this.activity.lastApplyMono, this.activity.applySeq);
    current = this;
  }
  save(): void {
    const s = useInboxStore.getState() as any;
    const out: Record<string, unknown> = {};
    for (const k of REPLICA_KEYS) out[k] = s[k];
    this.state = out;
    this.activity = { lastApplyMono: lastSyncApplyMono(), applySeq: syncApplySeq() };
    current = null;
  }
  // Every write this operation made leaves through the window's real tee:
  // a host broadcasts to its followers, a follower offers its action writes
  // to its host as a mut (attributed to itself so its own echo is skipped).
  async withStore<T>(fn: () => Promise<T> | T, origin?: string): Promise<T> {
    this.load();
    teePatches = [];
    teeState = null;
    teeIsAction = false;
    try {
      return await fn();
    } finally {
      const patches = teePatches;
      const state = teeState;
      const isAction = teeIsAction;
      this.save();
      if (this.device && patches.length > 0) {
        if (this.role === "host") {
          const updates = extractReplicationUpdates(patches, state, isReplicated, isReplicatedCollectionKey);
          if (updates.length > 0) this.device.broadcast(updates, origin ?? this.name, this);
        } else if (isAction) {
          const updates = buildMutUpdates(patches, state);
          if (updates.length > 0) this.device.mut(updates, this);
        }
      }
    }
  }
  compareState(): InboxCompareState {
    this.load();
    const s = useInboxStore.getState() as unknown as InboxCompareState;
    current = null;
    return s;
  }

  // ── Channels (host only: a follower holds no subscription) ──
  private feeds(): boolean {
    return this.online && this.role === "host";
  }
  // Same-machine delivery outruns the network: whatever the windows already
  // posted to each other lands before the host's next server push.
  private async settleWindows(): Promise<void> {
    await this.device?.drain();
  }
  async receiveBase(): Promise<void> {
    if (!this.feeds() || this.baseDead) return;
    await this.settleWindows();
    const { sessions } = await this.server.base();
    await this.withStore(() => useInboxStore.getState().syncTable("sessions", sessions as unknown as InboxSession[]));
  }
  async receiveOverlay(): Promise<void> {
    if (!this.feeds() || this.overlayDead) return;
    await this.settleWindows();
    const payload = await this.server.overlay();
    await this.withStore(() => useInboxStore.getState().applyInboxLivenessPayload("mine", payload));
  }
  async receiveDecisions(): Promise<void> {
    if (!this.feeds()) return;
    const rows = this.server.db._tables.session_decisions;
    await this.withStore(() => useInboxStore.getState().syncTable("sessionDecisions", rows));
  }
  // The sync-log catch-up: ids from the range, hydrated by the authorized
  // byIds query, overlaid as a delta; an id the query omitted is pruned. A
  // cursor below the retention floor takes the resync path: the floor is
  // recut and the rows it did not return are re-read by id.
  async catchUp(): Promise<void> {
    if (!this.feeds()) return;
    await this.settleWindows();
    const { ids, upTo, resync } = this.server.range(this.cursor);
    if (resync) {
      this.cursor = upTo;
      await this.withStore(() => {
        useInboxStore.getState().clearCrawlMetaForScope(`user:${ME}`);
        useInboxStore.getState().retireAckedPending(`user:${ME}`, upTo);
      });
      await this.crawl();
      return;
    }
    if (ids.length) {
      const rows = await this.server.byIds(ids);
      await this.withStore(() => {
        const store = useInboxStore.getState();
        store.retireAckedPending(`user:${ME}`, upTo);
        store.clearFeedExcludes("sessions", ids);
        if (rows.length) store.syncTable("sessions", rows as unknown as InboxSession[], { isDelta: true } as any);
        const present = new Set(rows.map((r: any) => String(r._id)));
        const missing = ids.filter((id) => !present.has(id));
        if (missing.length) store.pruneFeedEntities("sessions", missing);
      });
    }
    this.cursor = upTo;
  }
  // The completeness floor: every row in the 30-day window, once per cold or
  // resynced cache, then the durable watermark that lets the compare trust
  // the replica (gate 5). On a warm cache the rows the floor did not return
  // are re-read by id: returned rows land (hidden stamps and all), omitted
  // ids are gone or foreign and prune.
  async crawl(): Promise<void> {
    if (!this.feeds()) return;
    await this.settleWindows();
    const rows = await this.server.crawl(vnow - 30 * GEN_DAY);
    const returned = new Set(rows.map((r: any) => String(r._id)));
    const cached = Object.keys(this.state.sessions as Record<string, unknown>).filter((id) => !returned.has(id) && id.length === 32);
    const probed = cached.length ? await this.server.byIds(cached) : [];
    await this.withStore(() => {
      const store = useInboxStore.getState();
      store.clearFeedExcludes("sessions", rows.map((r: any) => String(r._id)));
      store.syncTable("sessions", rows as unknown as InboxSession[]);
      if (cached.length) {
        store.clearFeedExcludes("sessions", cached);
        if (probed.length) store.syncTable("sessions", probed as unknown as InboxSession[], { isDelta: true } as any);
        const present = new Set(probed.map((r: any) => String(r._id)));
        const missing = cached.filter((id) => !present.has(id));
        if (missing.length) store.pruneFeedEntities("sessions", missing);
      }
      store.recordSyncMeta(CRAWL_KEY, { backfilledAt: vnow });
    });
  }
  async receiveAll(): Promise<void> {
    await this.receiveBase();
    await this.receiveOverlay();
    await this.receiveDecisions();
    await this.catchUp();
  }

  // ── Gestures (the real store actions, then the dispatch to the server) ──
  private dispatchPending(id: string): void {
    const pending = this.state.pending as Record<string, any>;
    const patch: Record<string, any> = {};
    const keys: string[] = [];
    for (const [key, entry] of Object.entries(pending)) {
      if (entry?.type !== "field") continue;
      const [coll, docId, ...rest] = key.split(":");
      if (coll !== "conversations" || docId !== id) continue;
      patch[rest.join(":")] = entry.value ?? undefined;
      keys.push(rest.join(":"));
    }
    if (Object.keys(patch).length === 0) return;
    // applyHideTransition: a dismiss stamps the retired marker as well.
    if (patch.inbox_dismissed_at) patch.inbox_killed_at = patch.inbox_dismissed_at;
    const position = this.server.mutate(id, patch);
    // The dispatch acknowledgement (design D8): the acting window stamps the
    // log position its write landed at onto the locks that write created,
    // and announces it to its sibling windows over the bridge.
    const patches = { conversations: { [id]: Object.fromEntries(keys.map((k) => [k, pending[`conversations:${id}:${k}`].value])) } };
    const sentAt = vnow;
    this.load();
    useInboxStore.getState().stampSyncAck(patches, [{ scope_key: `user:${ME}`, position }], sentAt);
    this.save();
  }
  // A gesture can write MORE rows than its target (a kill cascades a dismiss
  // onto the session's subagents and teammates); prod dispatches one mutation
  // per written row, so the harness dispatches every unacknowledged pending
  // conversation write the gesture left behind, not only the target's.
  private dispatchTouched(): void {
    const pending = this.state.pending as Record<string, any>;
    const ids = new Set<string>();
    for (const [key, entry] of Object.entries(pending)) {
      if (entry?.type !== "field" || (entry as any).ack) continue;
      const [coll, docId] = key.split(":");
      if (coll === "conversations" && docId) ids.add(docId);
    }
    for (const id of ids) this.dispatchPending(id);
  }
  async pin(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().pinSession(id));
    this.dispatchTouched();
  }
  async kill(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().killSession(id));
    this.dispatchTouched();
  }
  async stash(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().stashSession(id));
    this.dispatchTouched();
  }
  async restore(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().restoreSession(id));
    this.dispatchTouched();
  }
  async revive(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().markBlockedReviveRequested([id]));
  }
  async setQueued(id: string, queued: boolean): Promise<void> {
    await this.withStore(() => useInboxStore.getState().setSessionHasQueuedMessages(id, queued));
  }
  async setQueuedAll(queued: boolean): Promise<void> {
    const ids = [...(this.state.sessionsWithQueuedMessages as Set<string>)];
    for (const id of ids) await this.setQueued(id, queued);
  }
  async focus(id: string | null): Promise<void> {
    await this.withStore(() => {
      declareViewNav("gesture");
      useInboxStore.setState({ currentSessionId: id } as any);
    });
  }

  // ── Replication + bridge receipt ──
  async applyReplication(updates: ReplicationUpdate[], origin: string): Promise<void> {
    if (this.role === "follower" && origin === this.name) return; // own echo
    // On a host every inbound update is a follower's mut (optimistic rows).
    await this.withStore(() => applyUpdatesToStore(updates, { optimistic: this.role === "host" }), origin);
  }
  async applyGesture(msg: GestureMessage): Promise<void> {
    await this.withStore(() => useInboxStore.getState().applyGestureBridge(msg));
  }
  // A follower's first contact: the host's whole replicated slice.
  async applySnapshot(host: Replica): Promise<void> {
    const entries = snapshotEntries(host.state, REPLICATED_STORE_KEYS as readonly string[]);
    const updates: ReplicationUpdate[] = [];
    for (const [key, value] of Object.entries(entries)) {
      if (isReplicatedCollectionKey(key)) updates.push({ key, upserts: Object.values(value ?? {}) });
      else updates.push({ key, value, hasValue: true });
    }
    await this.withStore(() => applyUpdatesToStore(updates));
  }

  // ── The compare loop ──
  tick(): InboxCompareOutcome {
    const outcome = this.comparer.tick(this.compareState());
    this.lastOutcome = outcome;
    return outcome;
  }
  // Run whatever the comparer scheduled (a jittered heal) to completion.
  async drainHeals(): Promise<number> {
    let ran = 0;
    while (this.scheduled.length) {
      const fn = this.scheduled.shift()!;
      fn();
      ran++;
      // The heal body is async; let it settle before the next scheduled item.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
    return ran;
  }
  eventsNamed(name: string): TrackedEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  // ── The rendered projection, from the chokepoint every surface uses ──
  placed() {
    this.load();
    const out = placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: vnow });
    current = null;
    return out;
  }
  membership(): string[] {
    return [...this.placed().placements.keys()].sort();
  }
  /** Rows this window renders in an active bucket — what its user can pin, kill, stash. */
  visibleIds(): string[] {
    return [...this.placed().placements].filter(([, p]) => p.bucket !== "dismissed" && p.bucket !== "stashed").map(([id]) => id).sort();
  }
  /** Rows this window renders as hidden (Dismissed / Stashed) — what its user can restore. */
  hiddenIds(): string[] {
    return [...this.placed().placements].filter(([, p]) => p.bucket === "dismissed" || p.bucket === "stashed").map(([id]) => id).sort();
  }
  /** Whether this window shows `id` in an active bucket right now. */
  shows(id: string): boolean {
    const p = this.placed().placements.get(id);
    return !!p && p.bucket !== "dismissed" && p.bucket !== "stashed";
  }
  placementsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, p] of this.placed().placements) out[id] = `${p.bucket}/${p.work_state}/${p.below_fold ? 1 : 0}`;
    return out;
  }
}

// ── A device: one host window plus followers, and their two channels ──────

type Delivery = { to: Replica; apply: () => Promise<void>; kind: "update" | "mut" | "gesture" };

export class Device {
  readonly windows: Replica[] = [];
  private queue: Delivery[] = [];
  constructor(readonly name: string, readonly host: Replica) {
    host.role = "host";
    host.device = this;
    this.windows.push(host);
  }
  get followers(): Replica[] {
    return this.windows.filter((w) => w.role === "follower");
  }
  async addFollower(follower: Replica): Promise<void> {
    follower.role = "follower";
    follower.device = this;
    this.windows.push(follower);
    await follower.applySnapshot(this.host);
  }
  /** The host's tee: every follower (but the origin) gets the update. */
  broadcast(updates: ReplicationUpdate[], origin: string, _from: Replica): void {
    for (const w of this.followers) {
      if (w.name === origin) continue;
      this.queue.push({ to: w, kind: "update", apply: () => w.applyReplication(updates, origin) });
    }
  }
  /** A follower's action write, offered to the host. */
  mut(updates: ReplicationUpdate[], from: Replica): void {
    this.queue.push({ to: this.host, kind: "mut", apply: () => this.host.applyReplication(updates, from.name) });
  }
  /** A gesture announced to every sibling window. */
  gesture(msg: GestureMessage, from: Replica): void {
    for (const w of this.windows) {
      if (w === from) continue;
      this.queue.push({ to: w, kind: "gesture", apply: () => w.applyGesture(msg) });
    }
  }
  pendingDeliveries(): number {
    return this.queue.length;
  }
  /** Deliver the next `n` queued messages in order (all of them by default). */
  async deliver(n = Infinity): Promise<number> {
    let delivered = 0;
    while (this.queue.length && delivered < n) {
      const d = this.queue.shift()!;
      await d.apply();
      delivered++;
    }
    return delivered;
  }
  /** Drain until nothing is queued, including what deliveries themselves enqueue. */
  async drain(): Promise<void> {
    while (this.queue.length) await this.deliver();
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
  // Every window's queued messages land, then the local overlays expire: the
  // revive TTL and the triage lock settle (a mut delivered after the clock
  // moved would plant a fresh lock and keep the compare off its short circuit).
  for (const r of replicas) {
    await r.setQueuedAll(false);
    await r.focus(null);
  }
  for (const d of devices) await d.drain();
  advance(Math.max(BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS) + GEN_MIN);
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
      const ids = [...outcome.diff.missing, ...outcome.diff.extra, ...outcome.diff.bucket_deltas, ...outcome.diff.fold_deltas];
      console.log(`[sim:trace] ${r.name} needs a heal: ${JSON.stringify({ diff: outcome.diff, detail: ids.map((id) => ({ id, server: server.conversations.find((c) => c._id === id) ?? null, replica: (r.state.sessions as any)[id] ?? null, pending: Object.entries(r.state.pending as Record<string, unknown>).filter(([k]) => k.includes(id)) })) }, null, 1)}`);
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
      // Replay aid: both sides of every disagreeing row, so a failing seed
      // names its cause instead of a digest.
      const ids = [...outcome.diff.missing, ...outcome.diff.extra, ...outcome.diff.bucket_deltas, ...outcome.diff.fold_deltas];
      const detail = ids.map((id) => ({
        id,
        server: server.conversations.find((c) => c._id === id) ?? null,
        stamp: (r.state.sessionsProjection as any).mine?.stamps?.[id] ?? null,
        replica: (r.state.sessions as any)[id] ?? null,
        pending: Object.entries(r.state.pending as Record<string, unknown>).filter(([k]) => k.includes(id)),
      }));
      throw new Error(`replica ${r.name} diverged at quiescence: ${JSON.stringify({ diff: outcome.diff, detail }, null, 1)}`);
    }
    if (heals > 0) await recanonicalize();
    expect({ replica: r.name, outcome }).toEqual({ replica: r.name, outcome: { kind: "clean", epoch: projection.epoch, short_circuit: true, payload_age_ms: expect.any(Number) } });
    const placed = r.placed();
    expect({ replica: r.name, digest: placed.set_digest }).toEqual({ replica: r.name, digest: projection.set_digest });
    expect({ replica: r.name, tally: placed.tally }).toEqual({ replica: r.name, tally: projection.tally });
    assertPlacements(server, r, r.placementsSnapshot(), canonicalPlacements, "canonical");
    expect(r.membership()).toEqual([...direct.placements.keys()].sort());
  }
  // Host against host, byte for byte — every host on the final payload.
  for (const r of hosts) await r.receiveOverlay();
  for (const d of devices) await d.drain();
  for (let i = 1; i < hosts.length; i++) {
    assertPlacements(server, hosts[i], hosts[i].placementsSnapshot(), hosts[0].placementsSnapshot(), hosts[0].name);
    expect(hosts[i].placed().set_digest).toBe(hosts[0].placed().set_digest);
  }
  // Every follower renders exactly what its host renders — a heal on the
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

// A placement mismatch names the rows and shows both sides' inputs, so a
// failing seed reads as a cause, not as a diff of two digests.
function assertPlacements(server: SimServer, r: Replica, got: Record<string, string>, want: Record<string, string>, against: string): void {
  const ids = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((id) => got[id] !== want[id]);
  if (ids.length === 0) return;
  const pick = (row: any) => row && Object.fromEntries(Object.entries(row).filter(([k]) => /status|agent_status|is_idle|updated_at|message_count|has_pending|awaiting|unresponsive|last_turn|settle_verdict|dormant|inbox_|is_pinned|is_deferred|started_at/.test(k)));
  const detail = ids.map((id) => ({
    id, got: got[id] ?? null, want: want[id] ?? null,
    server: pick(server.conversations.find((c) => c._id === id)),
    replica: pick((r.state.sessions as any)[id]),
    pending: Object.entries(r.state.pending as Record<string, unknown>).filter(([k]) => k.includes(id)),
  }));
  throw new Error(`${r.name} places ${ids.length} row(s) unlike ${against}: ${JSON.stringify(detail, null, 1)}`);
}

// ── Server-side events another device or the daemon would cause ────────────

export function newConversation(tag: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    _id: convexIdFor(tag),
    user_id: ME,
    status: "active",
    updated_at: vnow,
    started_at: vnow - GEN_MIN,
    message_count: 1,
    last_message_role: "user",
    title: `Session ${tag}`,
    ...over,
  };
}

export type ServerEvent = (server: SimServer, rng: () => number, step: number) => void;

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
  newSession: (s, _rng, step) => {
    const c = newConversation(`new${step}`);
    s.insert(c);
    s.setAgent(c._id, { agent_status: "working", last_heartbeat: vnow, agent_status_updated_at: vnow });
  },
  agentSettles: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.setAgent(id, { agent_status: "idle", last_heartbeat: vnow, agent_status_updated_at: vnow - 2 * GEN_MIN });
    s.mutate(id, { updated_at: vnow - 2 * GEN_MIN, message_count: (s.conv(id).message_count ?? 0) + 1 });
  },
  agentDeclaresDone: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.setAgent(id, { agent_status: "done", last_heartbeat: vnow, agent_status_updated_at: vnow });
  },
  agentStarts: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.setAgent(id, { agent_status: "working", last_heartbeat: vnow, agent_status_updated_at: vnow });
    s.mutate(id, { updated_at: vnow, message_count: (s.conv(id).message_count ?? 0) + 1 });
  },
  daemonDies: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.setAgent(id, { last_heartbeat: vnow - GEN_HOUR });
  },
  otherDevicePins: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { inbox_pinned_at: s.conv(id).inbox_pinned_at ? undefined : vnow });
  },
  otherDeviceDismisses: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { inbox_dismissed_at: vnow, inbox_killed_at: vnow });
  },
  otherDeviceStashes: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { inbox_stashed_at: vnow, inbox_stash_hidden: undefined });
  },
  otherDeviceRestores: (s, rng) => {
    const hidden = s.conversations.filter((c) => !c.is_subagent && (c.inbox_dismissed_at || c.inbox_stashed_at));
    if (!hidden.length) return;
    const c = hidden[Math.floor(rng() * hidden.length)];
    s.mutate(c._id, { inbox_dismissed_at: undefined, inbox_stashed_at: undefined, inbox_killed_at: undefined, inbox_stash_hidden: undefined });
  },
  gcDeletesBlank: (s, rng, step) => {
    // The empty-conversation GC: a blank row is hard-deleted; a replica that
    // cached it learns only through the log's delete (authorized absence).
    const blank = newConversation(`blank${step}`, { message_count: 0, last_message_role: undefined, started_at: vnow - GEN_DAY });
    s.insert(blank);
    if (rng() < 0.7) s.delete(blank._id);
  },
  triggerArms: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { armed_trigger_kind: s.conv(id).armed_trigger_kind === "standing" ? "none" : "standing" });
  },
  decisionQueued: (s, rng, step) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.db._tables.session_decisions.push({ _id: `sd_${step}`, user_id: ME, conversation_id: id, status: "pending", created_at: vnow });
  },
  decisionAnswered: (s) => {
    const open = s.db._tables.session_decisions.find((d: any) => d.status === "pending");
    if (open) open.status = "answered";
  },
  userParks: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { inbox_dormant_at: vnow });
  },
  apiErrorBanner: (s, rng) => {
    const id = memberIds(s, rng);
    if (!id) return;
    s.mutate(id, { pending_api_error: !s.conv(id).pending_api_error });
  },
};

// ── Fixtures ────────────────────────────────────────────────────────────────

export function seededWorld(seed: number, n = 45): GenWorld {
  return genWorld(seed, n, inboxEpoch(vnow), ME);
}

export async function bootReplica(server: SimServer, name: string, seed: number): Promise<Replica> {
  const r = new Replica(name, server, { seed });
  await r.crawl();
  await r.receiveAll();
  r.cursor = server.head();
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
