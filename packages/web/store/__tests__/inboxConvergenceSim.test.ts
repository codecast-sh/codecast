import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";

// Real Convex compute over dozens of rows, hundreds of steps: seconds on an
// idle machine, far more on a loaded one. Never a 5s test.
setDefaultTimeout(120_000);
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
  collectHiddenSessionsLite,
  _resetChildAuqProbeCacheForTests,
} from "@codecast/convex/convex/conversations";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { INBOX_PROJECTION_VERSION, inboxEpoch, projectInbox, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { GEN_DAY, GEN_HOUR, GEN_MIN, convexIdFor, genWorld, makeRng, type GenWorld } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import {
  useInboxStore,
  placeInboxRows,
  projectReplicaInbox,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
} from "../inboxStore";
import {
  INBOX_COMPARE_TICK_MS,
  INBOX_HEAL_BUDGET,
  INBOX_PROBE_PAYLOAD_AGE_MS,
  createInboxDigestComparer,
  evaluateInboxCompare,
  type InboxCompareOutcome,
  type InboxCompareState,
  type InboxDigestComparer,
} from "../inboxDigestCompare";
import { BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS } from "../inboxOverlays";
import { __resetSyncActivityForTests } from "../syncActivity";
import { declareViewNav } from "../viewNav";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { inboxCrawlWsKey } from "../../hooks/useSyncInboxSessions";
import { LIST_INBOX_SESSIONS_ARGS } from "../../hooks/useLiveInboxSessions";

// THE TWO-REPLICA SIMULATION — the eventual-consistency proof as a test
// (docs/architecture/sync-convergence.md, "Validation plan": Simulation).
//
// SERVER: the real Convex compute functions over an in-memory db (the live
// window, the liveness overlay, the byIds hydration, the completeness crawl)
// plus a sync log the sim appends to on every canonical write.
// REPLICAS: two snapshots of the real web store, swapped into the singleton
// one at a time, fed through the real appliers (syncTable, the overlay
// applier, the crawl watermark) and driven with the real gestures (pin,
// kill, stash, revive, queued send), each with its own log cursor, online
// flag and digest comparer.
// CLOCK: one virtual clock behind Date.now AND performance.now, so the
// projection epoch, the overlay receipt clock, the overlay bounds and the
// quiescence gate all move together and every run is replayable.
//
// The claim under test: whatever order payloads, ranges, crawls, gestures,
// reconnects and epoch ticks arrive in, at quiescence both replicas hold the
// same working set, the same placed buckets and the same digest, all equal to
// the projection computed directly over canonical state — and the compare
// loop says "clean" on both.

const ME = "u".repeat(32);
const CRAWL_KEY = syncMetaKey("sessions", inboxCrawlWsKey(ME));
const T0 = inboxEpoch(1_800_000_000_000) + 25_000;
const MONO0 = 10_000_000;

// ── The virtual clock ───────────────────────────────────────────────────────

let vnow = T0;
let nowSpy: ReturnType<typeof spyOn>;
let perfSpy: ReturnType<typeof spyOn>;
const mono = () => MONO0 + (vnow - T0);

beforeEach(() => {
  vnow = T0;
  nowSpy = spyOn(Date, "now").mockImplementation(() => vnow);
  perfSpy = spyOn(performance, "now").mockImplementation(() => mono());
  __resetSyncActivityForTests();
  __resetInboxPlacementCacheForTests();
  _resetChildAuqProbeCacheForTests();
  delete process.env.INBOX_DIGEST_DISABLED;
});
afterEach(() => {
  nowSpy.mockRestore();
  perfSpy.mockRestore();
  delete process.env.INBOX_DIGEST_DISABLED;
  // The singleton store outlives this file: leave no replica behind (a
  // future-epoch projection slot would age every later test's rows out of
  // the working set).
  useInboxStore.setState(freshReplicaState() as any);
  __resetInboxPlacementCacheForTests();
});

function advance(ms: number): void {
  vnow += ms;
}

// ── The server ──────────────────────────────────────────────────────────────

type LogEntry = { position: number; entity_id: string };

class SimServer {
  db: any;
  log: LogEntry[] = [];
  private position = 0;
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
  mutate(id: string, patch: Record<string, any>): void {
    Object.assign(this.conv(id), patch);
    this.log.push({ position: ++this.position, entity_id: id });
  }
  insert(conv: Record<string, any>): void {
    this.conversations.push(conv);
    this.log.push({ position: ++this.position, entity_id: conv._id });
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
  // The dismissed / stashed lite reconciles: the server's CURRENT hidden set
  // inside the window, ids and stamps only.
  async hiddenLite(field: "inbox_dismissed_at" | "inbox_stashed_at"): Promise<Array<Record<string, any>>> {
    const index = field === "inbox_dismissed_at" ? "by_user_dismissed" : "by_user_stashed";
    const res: any = await collectHiddenSessionsLite(
      { db: this.db }, ME as any, { since: vnow - 30 * GEN_DAY, paginationOpts: { numItems: 1000, cursor: null } }, index, field,
    );
    return res.page ?? [];
  }
  range(from: number): { ids: string[]; upTo: number } {
    const entries = this.log.filter((e) => e.position > from);
    return { ids: [...new Set(entries.map((e) => e.entity_id))], upTo: this.position };
  }
}

// ── A replica ───────────────────────────────────────────────────────────────

// The store keys a replica owns. Everything the projection, the overlays and
// the compare read, plus the row twins the gestures write.
const REPLICA_KEYS = [
  "sessions", "conversations", "messages", "pagination", "sessionsProjection", "pending",
  "pendingMessages", "pendingSessionCreates", "sessionsWithQueuedMessages", "blockedReviveRequestedAt",
  "currentSessionId", "sessionDecisions", "questionResolutions", "currentUser", "clientState",
  "syncMeta", "syncProgress", "liveInboxIds", "liveInboxIdList", "teamInboxIds",
] as const;

function freshReplicaState(): Record<string, unknown> {
  return {
    sessions: {}, conversations: {}, messages: {}, pagination: {}, sessionsProjection: {}, pending: {},
    pendingMessages: {}, pendingSessionCreates: {}, sessionsWithQueuedMessages: new Set(), blockedReviveRequestedAt: {},
    currentSessionId: null, sessionDecisions: {}, questionResolutions: {}, currentUser: { _id: ME },
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: false } },
    syncMeta: {}, syncProgress: {}, liveInboxIds: new Set(), liveInboxIdList: [], teamInboxIds: new Set(),
  };
}

type TrackedEvent = { event: string; props: Record<string, unknown> };

class Replica {
  state: Record<string, unknown> = freshReplicaState();
  cursor = 0;
  online = true;
  /** Zombie flags: a subscription that stopped pushing while the socket looks fine. */
  baseDead = false;
  overlayDead = false;
  events: TrackedEvent[] = [];
  comparer: InboxDigestComparer;
  lastOutcome: InboxCompareOutcome | null = null;
  private healSeq = 0;

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
  private scheduled: Array<() => void> = [];

  // Swap this replica into the singleton store for one operation.
  load(): void {
    __resetInboxPlacementCacheForTests();
    declareViewNav("gesture");
    useInboxStore.setState(this.state as any);
  }
  save(): void {
    const s = useInboxStore.getState() as any;
    const out: Record<string, unknown> = {};
    for (const k of REPLICA_KEYS) out[k] = s[k];
    this.state = out;
  }
  async withStore<T>(fn: () => Promise<T> | T): Promise<T> {
    this.load();
    try {
      return await fn();
    } finally {
      this.save();
    }
  }
  compareState(): InboxCompareState {
    this.load();
    return useInboxStore.getState() as unknown as InboxCompareState;
  }

  // ── Channels ──
  async receiveBase(): Promise<void> {
    if (!this.online || this.baseDead) return;
    const { sessions } = await this.server.base();
    await this.withStore(() => useInboxStore.getState().syncTable("sessions", sessions as unknown as InboxSession[]));
  }
  async receiveOverlay(): Promise<void> {
    if (!this.online || this.overlayDead) return;
    const payload = await this.server.overlay();
    await this.withStore(() => useInboxStore.getState().applyInboxLivenessPayload("mine", payload));
  }
  async receiveDecisions(): Promise<void> {
    if (!this.online) return;
    const rows = this.server.db._tables.session_decisions;
    await this.withStore(() => useInboxStore.getState().syncTable("sessionDecisions", rows));
  }
  // The sync-log catch-up: ids from the range, hydrated by the authorized
  // byIds query, overlaid as a delta; an id the query omitted is pruned.
  async catchUp(): Promise<void> {
    if (!this.online) return;
    const { ids, upTo } = this.server.range(this.cursor);
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
  // The completeness crawl: every row in the 30-day window, then the
  // durable watermark that lets the compare trust the replica (gate 5).
  async crawl(): Promise<void> {
    if (!this.online) return;
    const rows = await this.server.crawl(vnow - 30 * GEN_DAY);
    await this.withStore(() => {
      const store = useInboxStore.getState();
      store.syncTable("sessions", rows as unknown as InboxSession[]);
      store.recordSyncMeta(CRAWL_KEY, { backfilledAt: vnow });
    });
  }
  // The subtractive healers for hide state: a complete crawl of the current
  // dismissed / stashed set SETS what it reports and CLEARS what it omits.
  async reconcileHidden(): Promise<void> {
    if (!this.online) return;
    const dismissed = await this.server.hiddenLite("inbox_dismissed_at");
    const stashed = await this.server.hiddenLite("inbox_stashed_at");
    await this.withStore(() => {
      const store = useInboxStore.getState();
      store.applyDismissedReconcile(dismissed as any, true);
      store.applyStashedReconcile(stashed as any, true);
    });
  }
  async receiveAll(): Promise<void> {
    await this.receiveBase();
    await this.receiveOverlay();
    await this.receiveDecisions();
    await this.catchUp();
    await this.reconcileHidden();
  }

  // ── Gestures (the real store actions, then the dispatch to the server) ──
  private dispatchPending(id: string): void {
    const pending = this.state.pending as Record<string, any>;
    const patch: Record<string, any> = {};
    for (const [key, entry] of Object.entries(pending)) {
      if (entry?.type !== "field") continue;
      const [coll, docId, ...rest] = key.split(":");
      if (coll !== "conversations" || docId !== id) continue;
      patch[rest.join(":")] = entry.value ?? undefined;
    }
    if (Object.keys(patch).length === 0) return;
    // applyHideTransition: a dismiss stamps the retired marker as well.
    if (patch.inbox_dismissed_at) patch.inbox_killed_at = patch.inbox_dismissed_at;
    this.server.mutate(id, patch);
  }
  async pin(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().pinSession(id));
    this.dispatchPending(id);
  }
  async kill(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().killSession(id));
    this.dispatchPending(id);
  }
  async stash(id: string): Promise<void> {
    await this.withStore(() => useInboxStore.getState().stashSession(id));
    this.dispatchPending(id);
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
    this.healSeq += ran;
    return ran;
  }
  eventsNamed(name: string): TrackedEvent[] {
    return this.events.filter((e) => e.event === name);
  }

  // ── The rendered projection, from the chokepoint every surface uses ──
  placed() {
    this.load();
    return placeInboxRows(useInboxStore.getState() as any, { scope: "mine", now: vnow });
  }
  membership(): string[] {
    return [...this.placed().placements.keys()].sort();
  }
  placementsSnapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, p] of this.placed().placements) out[id] = `${p.bucket}/${p.work_state}/${p.below_fold ? 1 : 0}`;
    return out;
  }
}

// The canonical projection, computed directly: the shared module over the
// server's conversations with the overlay's facts merged on (the same
// adapter every replica applies), at the payload's epoch.
async function canonicalProjection(server: SimServer) {
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
async function quietTick(r: Replica, opts: { overlay?: boolean } = {}): Promise<InboxCompareOutcome> {
  advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
  if (opts.overlay !== false) await r.receiveOverlay();
  return r.tick();
}

// Quiescence: everyone online, every channel delivered, the clock past every
// overlay bound and the quiescence window, then the proof.
async function settleAndAssertConverged(server: SimServer, replicas: Replica[]): Promise<void> {
  for (const r of replicas) {
    r.online = true;
    r.baseDead = false;
    r.overlayDead = false;
  }
  // Local overlays expire: the revive TTL and the triage lock settle.
  advance(Math.max(BLOCKED_REVIVE_TTL_MS, HIDDEN_OVERRIDE_SETTLE_MS) + GEN_MIN);
  for (const r of replicas) {
    await r.setQueuedAll(false);
    await r.focus(null);
    await r.receiveAll();
  }
  // Two quiet ticks with no row applies, then a fresh overlay for everyone
  // (the overlay is not sync activity) and the proof at THAT instant: the
  // server executed at this clock, so the replica's trust decay and render
  // epoch evaluate at the same time the stamps were computed.
  advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
  for (const r of replicas) await r.receiveOverlay();

  const healedReplicas: string[] = [];
  let { direct, projection } = await canonicalProjection(server);
  const canonicalPlacements: Record<string, string> = {};
  for (const [id, p] of direct.placements) canonicalPlacements[id] = `${p.bucket}/${p.work_state}/${p.below_fold ? 1 : 0}`;

  for (const r of replicas) {
    let outcome = r.tick();
    // The sync channels alone are not the whole proof: the anti-entropy loop
    // is. A replica the channels left diverged (a settled pin lock that
    // re-asserted a local pin over a remote kill, which no channel re-delivers)
    // must converge through the compare's own heal, within ONE budget: the
    // persistence rule (a second compare at a distinct payload epoch), then
    // the targeted heal, then clean.
    let heals = 0;
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
    if (heals > 0) {
      ({ direct, projection } = await canonicalProjection(server));
      for (const id of Object.keys(canonicalPlacements)) delete canonicalPlacements[id];
      for (const [id, p] of direct.placements) canonicalPlacements[id] = `${p.bucket}/${p.work_state}/${p.below_fold ? 1 : 0}`;
      for (const other of replicas) if (other !== r) await other.receiveOverlay();
    }
    expect({ replica: r.name, outcome }).toEqual({ replica: r.name, outcome: { kind: "clean", epoch: projection.epoch, short_circuit: true, payload_age_ms: expect.any(Number) } });
    const placed = r.placed();
    expect({ replica: r.name, digest: placed.set_digest }).toEqual({ replica: r.name, digest: projection.set_digest });
    expect({ replica: r.name, tally: placed.tally }).toEqual({ replica: r.name, tally: projection.tally });
    expect({ replica: r.name, placements: r.placementsSnapshot() }).toEqual({ replica: r.name, placements: canonicalPlacements });
    expect(r.membership()).toEqual([...direct.placements.keys()].sort());
  }
  // Replica against replica, byte for byte.
  for (let i = 1; i < replicas.length; i++) {
    expect(replicas[i].placementsSnapshot()).toEqual(replicas[0].placementsSnapshot());
    expect(replicas[i].placed().set_digest).toBe(replicas[0].placed().set_digest);
  }
  return healedReplicas;
}

// ── Server-side events another device or the daemon would cause ────────────

function newConversation(tag: string, over: Record<string, any> = {}): Record<string, any> {
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

type ServerEvent = (server: SimServer, rng: () => number, step: number) => void;

const memberIds = (server: SimServer, rng: () => number): string | null => {
  const ids = server.conversations.filter((c) => !c.is_subagent && !c.inbox_killed_at).map((c) => c._id);
  return ids.length ? ids[Math.floor(rng() * ids.length)] : null;
};

const SERVER_EVENTS: Record<string, ServerEvent> = {
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

function seededWorld(seed: number, n = 45): GenWorld {
  const world = genWorld(seed, n, inboxEpoch(vnow), ME);
  // The generator writes conversation facts the overlay strips
  // (has_pending_messages is a real row field; keep it) — nothing to adapt.
  return world;
}

async function bootReplica(server: SimServer, name: string, seed: number): Promise<Replica> {
  const r = new Replica(name, server, { seed });
  await r.crawl();
  await r.receiveAll();
  r.cursor = server.head();
  return r;
}

// ── The scenarios ───────────────────────────────────────────────────────────

describe("two replicas converge", () => {
  it("hand-written interleaving: pin, dismiss, settle, trigger arm, queued send, revive, reconnect, epoch ticks — in different orders", async () => {
    const server = new SimServer(seededWorld(11));
    const a = await bootReplica(server, "A", 1);
    const b = await bootReplica(server, "B", 2);
    const ids = server.conversations.filter((c) => !c.is_subagent && !c.inbox_killed_at && !c.inbox_dismissed_at && !c.inbox_stashed_at).map((c) => c._id);
    const [p, q, r, s, t] = ids;

    // A pins p and kills q locally; B sees neither yet.
    await a.pin(p);
    await a.kill(q);
    // B stashes r while offline — its gesture reaches the server, its view of
    // A's gestures does not arrive until it reconnects.
    b.online = false;
    await b.stash(r);
    // The daemon settles s and a trigger arms on t (server-side facts).
    SERVER_EVENTS.agentSettles(server, () => 0.0, 0);
    server.mutate(t, { armed_trigger_kind: "standing" });
    // A queues a send on t and revives s (local overlays), then a minute passes.
    await a.setQueued(t, true);
    await a.revive(s);
    advance(GEN_MIN);
    await a.receiveAll();
    // Mid-flight: A's overlays make its compare fall through to the per-row
    // diff, which drops the affected ids — never drift.
    advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
    const mid = a.tick();
    expect(mid.kind === "clean" || mid.kind === "diff").toBe(true);
    // B reconnects a few minutes later, in the other order: overlay first,
    // then the log, then the base window.
    advance(3 * GEN_MIN);
    b.online = true;
    await b.receiveOverlay();
    await b.catchUp();
    await b.receiveBase();
    await settleAndAssertConverged(server, [a, b]);
    // No drift was ever counted on either side.
    expect(a.eventsNamed("inbox_drift")).toEqual([]);
    expect(b.eventsNamed("inbox_drift")).toEqual([]);
  });

  it("randomized interleavings over seeded worlds: any order of payloads, ranges, crawls, gestures, reconnects and epoch ticks converges", async () => {
    // Replay one seed with SIM_SEEDS=25 (comma separated).
    const seeds = process.env.SIM_SEEDS ? process.env.SIM_SEEDS.split(",").map(Number) : [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
    const healedSeeds: string[] = [];
    for (const seed of seeds) {
      vnow = T0;
      __resetSyncActivityForTests();
      _resetChildAuqProbeCacheForTests();
      const server = new SimServer(seededWorld(seed));
      const a = await bootReplica(server, `A${seed}`, seed);
      const b = await bootReplica(server, `B${seed}`, seed + 100);
      const rng = makeRng(seed * 7);
      const replicas = [a, b];
      const eventNames = Object.keys(SERVER_EVENTS);
      for (let step = 0; step < 60; step++) {
        const roll = rng();
        const r = replicas[Math.floor(rng() * replicas.length)];
        const target = memberIds(server, rng);
        if (roll < 0.3) {
          SERVER_EVENTS[eventNames[Math.floor(rng() * eventNames.length)]](server, rng, step);
        } else if (roll < 0.4 && target) {
          await r.pin(target);
        } else if (roll < 0.45 && target) {
          await r.kill(target);
        } else if (roll < 0.5 && target) {
          await r.stash(target);
        } else if (roll < 0.55 && target) {
          await r.revive(target);
        } else if (roll < 0.6 && target) {
          await r.setQueued(target, true);
        } else if (roll < 0.63 && target) {
          await r.focus(target);
        } else if (roll < 0.7) {
          r.online = !r.online;
        } else if (roll < 0.78) {
          await r.receiveBase();
        } else if (roll < 0.86) {
          await r.receiveOverlay();
        } else if (roll < 0.9) {
          await r.catchUp();
        } else if (roll < 0.93) {
          await r.crawl();
        } else if (roll < 0.96) {
          await r.reconcileHidden();
        } else {
          advance([15_000, GEN_MIN, 5 * GEN_MIN, GEN_HOUR][Math.floor(rng() * 4)]);
        }
        if (rng() < 0.5) advance(Math.floor(rng() * 20_000));
      }
      const healed = await settleAndAssertConverged(server, replicas);
      if (healed.length) healedSeeds.push(`${seed}:${healed.join("|")}`);
    }
    // The channels alone leave a bounded residue (the pin-over-kill lock
    // case); the loop closes it. Printed so a reader sees which seeds needed
    // the heal, and pinned loosely so a channel regression that makes EVERY
    // seed depend on the heal is visible.
    console.log(`[sim] seeds converged through the heal: ${healedSeeds.join(", ") || "none"}`);
    expect(healedSeeds.length).toBeLessThan(seeds.length / 2);
  });
});

describe("the cold replica", () => {
  it("compares nothing until its crawl completes; then the base list's fold omission heals within one budget", async () => {
    // A world whose fresh cluster sits a day above a tail of older rows: the
    // base list omits the tail (transport fold), the overlay stamps it.
    const world = seededWorld(31, 30);
    for (let i = 0; i < 6; i++) {
      world.conversations.push({
        _id: convexIdFor(`tail${i}`), user_id: ME, status: "active", updated_at: vnow - 2 * GEN_DAY - i * GEN_HOUR,
        started_at: vnow - 3 * GEN_DAY, message_count: 3, last_message_role: "assistant", title: `Tail ${i}`,
      });
    }
    const server = new SimServer(world);
    const warm = await bootReplica(server, "warm", 1);
    const cold = new Replica("cold", server, { seed: 2 });
    // The cold device: live window + overlay only, no crawl yet.
    await cold.receiveBase();
    await cold.receiveOverlay();
    await cold.receiveDecisions();
    const { liveness } = await server.overlay();
    const folded = Object.entries(liveness).filter(([, r]: any) => r.below_fold).map(([id]) => id);
    expect(folded.length).toBeGreaterThan(0);
    for (const id of folded) expect((cold.state.sessions as any)[id]).toBeUndefined();

    expect(await quietTick(cold)).toMatchObject({ kind: "skip", reason: "cold_replica" });
    expect(cold.comparer.counters().skips.cold_replica).toBe(1);
    expect(cold.comparer.counters().checks).toBe(0);

    // The crawl completes and stamps the watermark. It is additive and
    // window-bounded, so it may or may not carry every stamped member; what
    // it cannot carry, the compare finds and the heal hydrates by id.
    await cold.crawl();
    const first = await quietTick(cold);
    if (first.kind === "diff") {
      expect(first.diff.extra).toEqual([]);
      expect(first.diff.bucket_deltas).toEqual([]);
      // Persistence rule: a second compare at a DISTINCT payload epoch.
      advance(GEN_MIN);
      const second = await quietTick(cold);
      expect(second.kind).toBe("diff");
      expect(cold.eventsNamed("inbox_drift").length).toBe(1);
      expect(await cold.drainHeals()).toBe(1);
      expect(cold.comparer.counters().heals).toBe(1);
      expect(cold.comparer.counters().heals).toBeLessThanOrEqual(INBOX_HEAL_BUDGET);
    } else {
      expect(first.kind).toBe("clean");
    }
    expect(await quietTick(cold)).toMatchObject({ kind: "clean" });
    expect(cold.comparer.healLatched()).toBe(false);
    await settleAndAssertConverged(server, [warm, cold]);
  });
});

describe("a dead subscription is detected and healed", () => {
  it("overlay zombie: the payload ages out, the stale probe forces a fresh execution, the replica re-converges", async () => {
    const server = new SimServer(seededWorld(41));
    const a = await bootReplica(server, "A", 1);
    const id = memberIds(server, () => 0.3)!;
    a.overlayDead = true;
    // The world moves: a fact flips server-side that only the overlay carries.
    server.setAgent(id, { agent_status: "working", last_heartbeat: vnow, agent_status_updated_at: vnow });
    server.mutate(id, { updated_at: vnow, message_count: 9 });
    advance(2 * GEN_MIN);
    await a.receiveBase();
    await a.catchUp();
    // Gate 3: the payload is older than the bound — skipped, counted, no heal.
    expect(await quietTick(a, { overlay: false })).toMatchObject({ kind: "skip", reason: "stale_payload" });
    expect(a.comparer.counters().skips.stale_payload).toBe(1);
    // Rendering over frozen facts falls back to the client sweep: the row the
    // server now calls working still reads from the last payload, and a row
    // whose liveness froze past the trust TTL settles honestly rather than
    // pinning a stale "working" — the compare never sees this (gated).
    const frozen = a.placed();
    expect(frozen.placements.get(id)?.bucket).not.toBe("working");
    // Past the probe age the comparer issues ONE budgeted probe.
    advance(INBOX_PROBE_PAYLOAD_AGE_MS);
    a.tick();
    expect(a.comparer.counters().probes).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The fresh payload landed through the applier: the probe's own execution
    // clock is the tick's, so the very next tick is clean.
    expect(a.tick()).toMatchObject({ kind: "clean" });
    expect(a.comparer.counters().heals).toBe(0);
    a.overlayDead = false;
    await settleAndAssertConverged(server, [a]);
  });

  it("base zombie: a row the overlay stamps but the window never delivered is missing, persists across two payload epochs, and heals by id", async () => {
    const server = new SimServer(seededWorld(42));
    const a = await bootReplica(server, "A", 1);
    a.baseDead = true;
    // A new session starts elsewhere; A's log cursor is stuck too (same socket).
    a.online = false;
    SERVER_EVENTS.newSession(server, () => 0, 99);
    const newId = convexIdFor("new99");
    a.online = true;
    const first = await quietTick(a);
    expect(first).toMatchObject({ kind: "diff", diff: { missing: [newId], extra: [], bucket_deltas: [], fold_deltas: [] } });
    // One tick between the pushes is a race, not drift: nothing counted yet.
    expect(a.comparer.counters().mismatches).toBe(0);
    advance(GEN_MIN);
    expect((await quietTick(a)).kind).toBe("diff");
    expect(a.comparer.counters().mismatches).toBe(1);
    expect(a.eventsNamed("inbox_drift")).toEqual([
      { event: "inbox_drift", props: expect.objectContaining({ missing: 1, extra: 0, bucket_deltas: 0, fold_deltas: 0, scope: "mine", platform: "sim-A" }) },
    ]);
    expect(await a.drainHeals()).toBe(1);
    expect(a.comparer.counters()).toMatchObject({ heals: 1, heals_missing: 1 });
    expect((a.state.sessions as any)[newId]).toBeDefined();
    expect(await quietTick(a)).toMatchObject({ kind: "clean" });
    expect(a.comparer.healLatched()).toBe(false);
    // Still one drift event: the same digest never reports twice.
    expect(a.eventsNamed("inbox_drift").length).toBe(1);
  });

  it("a persistent extra is reported, never deleted: three heals, then the latch", async () => {
    const server = new SimServer(seededWorld(43));
    const a = await bootReplica(server, "A", 1);
    // A ghost only this replica holds (a row the server will never return).
    const ghost = convexIdFor("ghost");
    await a.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: vnow, message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    // Every compare reports the ghost; the persistence rule confirms one
    // drift per two payload epochs, each confirmation spends a heal, and the
    // fourth confirmation latches instead of healing.
    let healsRun = 0;
    let rounds = 0;
    while (!a.comparer.healLatched() && rounds < 2 * (INBOX_HEAL_BUDGET + 2)) {
      advance(GEN_MIN);
      const out = await quietTick(a);
      expect(out).toMatchObject({ kind: "diff", diff: { missing: [], extra: [ghost] } });
      healsRun += await a.drainHeals();
      rounds++;
    }
    expect(rounds).toBe(2 * (INBOX_HEAL_BUDGET + 1));
    expect(healsRun).toBe(INBOX_HEAL_BUDGET);
    expect(a.comparer.healLatched()).toBe(true);
    expect(a.eventsNamed("inbox_drift_persistent").length).toBe(1);
    expect(a.comparer.counters().heals).toBe(INBOX_HEAL_BUDGET);
    // The ghost row is still there: deletion truth is authorized absence.
    expect((a.state.sessions as any)[ghost]).toBeDefined();
    // ONE inbox_drift event: the digest never changed, so no repeat.
    expect(a.eventsNamed("inbox_drift").length).toBe(1);
  });
});

describe("the two drills", () => {
  it("a client on the wrong projection version stays silent: one skew metric, no heal, no drift", async () => {
    const server = new SimServer(seededWorld(51));
    const a = await bootReplica(server, "A", 1);
    // Diverge the replica on purpose so a compare WOULD report drift…
    const ghost = convexIdFor("ghost");
    await a.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: vnow, message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    // …then feed it payloads from a server one version ahead (the deploy skew
    // window: convex shipped v+1 before this bundle reloaded).
    const skewed = async () => {
      const payload = await server.overlay();
      return { ...payload, projection: { ...payload.projection, v: INBOX_PROJECTION_VERSION + 1 } };
    };
    for (let round = 0; round < 4; round++) {
      advance(GEN_MIN);
      const payload = await skewed();
      await a.withStore(() => useInboxStore.getState().applyInboxLivenessPayload("mine", payload));
      advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
      expect(a.tick()).toMatchObject({ kind: "skip", reason: "version_skew", payload_v: INBOX_PROJECTION_VERSION + 1 });
      expect(await a.drainHeals()).toBe(0);
    }
    expect(a.comparer.counters().skips.version_skew).toBe(4);
    expect(a.comparer.counters().checks).toBe(0);
    expect(a.eventsNamed("inbox_digest_version_skew")).toEqual([
      { event: "inbox_digest_version_skew", props: expect.objectContaining({ payload_v: INBOX_PROJECTION_VERSION + 1, client_v: INBOX_PROJECTION_VERSION }) },
    ]);
    expect(a.eventsNamed("inbox_drift")).toEqual([]);
    // The rendered inbox is untouched by the skew: the replica still renders
    // from its own computation (the stamps were never a render source).
    expect(a.placed().placements.has(ghost)).toBe(true);
  });

  it("INBOX_DIGEST_DISABLED propagates on the next overlay execution: null digest, compare and heal off, telemetry names it", async () => {
    const server = new SimServer(seededWorld(52));
    const a = await bootReplica(server, "A", 1);
    const b = await bootReplica(server, "B", 2);
    expect((await quietTick(a)).kind).toBe("clean");
    // The switch flips on the Convex env. The payload already delivered still
    // carries a digest; the NEXT execution carries null — propagation is one
    // overlay cadence, no deploy.
    process.env.INBOX_DIGEST_DISABLED = "1";
    expect((a.state.sessionsProjection as any).mine.set_digest).not.toBeNull();
    // Diverge B so the kill switch has something to suppress.
    const ghost = convexIdFor("ghost");
    await b.withStore(() => useInboxStore.getState().syncTable("sessions", [
      { _id: ghost, session_id: "sess-ghost", user_id: ME, status: "active", updated_at: vnow, message_count: 3, is_idle: true, title: "Ghost" },
    ] as unknown as InboxSession[]));
    advance(GEN_MIN);
    const flipAt = vnow;
    await a.receiveOverlay();
    await b.receiveOverlay();
    expect((a.state.sessionsProjection as any).mine.set_digest).toBeNull();
    expect((b.state.sessionsProjection as any).mine.set_digest).toBeNull();
    // Stamps and facts still ride the payload (rendering freshness is untouched).
    expect(Object.keys((a.state.sessionsProjection as any).mine.stamps).length).toBeGreaterThan(0);
    advance(2 * INBOX_COMPARE_TICK_MS + 1_000);
    for (let round = 0; round < 3; round++) {
      expect(a.tick()).toEqual({ kind: "disabled" });
      expect(b.tick()).toEqual({ kind: "disabled" });
      expect(await b.drainHeals()).toBe(0);
      advance(INBOX_PROBE_PAYLOAD_AGE_MS + GEN_MIN);
    }
    expect(b.comparer.counters()).toMatchObject({ disabled: 3, checks: 0, heals: 0, probes: 0 });
    expect(b.eventsNamed("inbox_drift")).toEqual([]);
    // Propagation time: the first null payload is the first execution after
    // the flip — within one overlay cycle.
    expect((a.state.sessionsProjection as any).mine.epoch).toBe(inboxEpoch(flipAt));
    // Switching it back off restores the compare on the next payload.
    delete process.env.INBOX_DIGEST_DISABLED;
    advance(GEN_MIN);
    expect((await quietTick(a)).kind).toBe("clean");
  });
});

describe("the pure compare on the same replicas", () => {
  it("evaluateInboxCompare at the payload epoch agrees with the loop's verdict after convergence", async () => {
    const server = new SimServer(seededWorld(61));
    const a = await bootReplica(server, "A", 1);
    await settleAndAssertConverged(server, [a]);
    const state = a.compareState();
    const slot = (state.sessionsProjection as any).mine;
    const out = evaluateInboxCompare(state, { now: vnow, nowMono: mono(), crawlMetaKey: CRAWL_KEY, lastApplyMono: mono() - 10 * GEN_MIN, inflight: 0 });
    expect(out).toMatchObject({ kind: "clean", short_circuit: true, epoch: slot.epoch });
    const { proj } = projectReplicaInbox(state, { scope: "mine", focusedId: null, epoch: slot.epoch, now: vnow });
    expect(proj.set_digest).toBe(slot.set_digest);
  });
});
