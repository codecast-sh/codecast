import { beforeEach, describe, expect, it } from "bun:test";
import { INBOX_PROJECTION_VERSION, STATUS_TRUST_TTL_MS, inboxEpoch, type InboxBucket } from "@codecast/shared/contracts";
import {
  INBOX_COMPARE_MAX_PAYLOAD_AGE_MS,
  INBOX_COMPARE_QUIESCENT_MS,
  INBOX_COMPARE_SKIPS,
  INBOX_HEAL_BUDGET,
  INBOX_HEAL_WINDOW_MS,
  INBOX_HEARTBEAT_INTERVAL_MS,
  INBOX_PROBE_MIN_INTERVAL_MS,
  INBOX_PROBE_PAYLOAD_AGE_MS,
  createInboxDigestComparer,
  evaluateInboxCompare,
  type InboxCompareState,
  type InboxDigestComparerIO,
} from "../inboxDigestCompare";
import {
  projectReplicaInbox,
  type InboxProjectionStamp,
  type InboxSession,
  type SessionsProjectionSlot,
} from "../inboxStore";
import { __resetSyncActivityForTests } from "../syncActivity";

// The anti-entropy loop (sync-convergence C6/C7/C8): gates in contract order,
// the per-row diff with its carve-outs, the persistence rule, the bounded
// heal and its latch, the stale-payload probe, and the telemetry contract
// (counts only, zeros included). The "server" side of every fixture is the
// SAME shared module run over the same rows (projectReplicaInbox), which is
// exactly the model: two runs of one computation over one data set agree.

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const MONO = 500_000;
const ME = "u".repeat(32);
const CRAWL_KEY = "sessions:v2:inbox:" + ME;

const cid = (tag: string) => (tag + "0".repeat(32)).slice(0, 32);
const A = cid("a");
const B = cid("b");
const C = cid("c");
const D = cid("d");

function row(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id,
    session_id: `sess-${id.slice(0, 2)}`,
    agent_type: "claude_code",
    user_id: ME,
    status: "active",
    updated_at: EPOCH - 10 * MIN,
    message_count: 3,
    is_idle: true,
    agent_status: "idle",
    has_pending: false,
    // A live daemon behind the row, as the overlay ships it (ct-47609): the
    // replica derives is_idle and the status trust from these facts, so a
    // "working" row with no heartbeat would read as a dead daemon on both
    // sides and the deliberate deltas below would vanish.
    // The heartbeat outlives every epoch these tests advance through (a real
    // daemon keeps heartbeating; a fixed stamp would die mid-test and both
    // sides would agree on "stopped").
    agent_status_updated_at: EPOCH - 10 * MIN,
    last_heartbeat: EPOCH + H,
    daemon_alive_until: EPOCH + 2 * H,
    last_role_is_user: false,
    ...extra,
  } as InboxSession;
}

function baseState(sessions: Record<string, InboxSession>, over: Partial<InboxCompareState> = {}): InboxCompareState {
  return {
    sessions,
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: false } },
    currentUser: { _id: ME },
    sessionsProjection: {},
    sessionDecisions: {},
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    pending: {},
    syncMeta: { [CRAWL_KEY]: { backfilledAt: NOW - DAY } },
    syncProgress: {},
    ...over,
  };
}

// The server's run of the shared module over the same rows → stamps + digest.
// The server evaluates AT THE EPOCH (computeSessionsLiveness: now =
// inboxEpoch(Date.now())), trust decay included — never at its wall clock.
function serverSlot(state: InboxCompareState, over: Partial<SessionsProjectionSlot> = {}): SessionsProjectionSlot {
  const epoch = over.epoch ?? EPOCH;
  const { proj } = projectReplicaInbox(state, { scope: "mine", focusedId: null, epoch, now: epoch });
  const stamps: Record<string, InboxProjectionStamp> = {};
  for (const [id, p] of proj.placements) {
    stamps[id] = { bucket: p.bucket, work_state: p.work_state, asking: false, below_fold: p.below_fold, bucket_stale_at: null, stale_bucket: null };
  }
  return {
    v: INBOX_PROJECTION_VERSION,
    epoch: EPOCH,
    receivedAtMono: MONO,
    tally: proj.tally,
    set_digest: proj.set_digest,
    truncated: [...proj.truncated],
    stamps,
    ...over,
  };
}

function withSlot(state: InboxCompareState, over: Partial<SessionsProjectionSlot> = {}): InboxCompareState {
  return { ...state, sessionsProjection: { mine: serverSlot(state, over) } };
}

const ctx = (over: Partial<Parameters<typeof evaluateInboxCompare>[1]> = {}) => ({
  now: NOW,
  nowMono: MONO + 1_000,
  crawlMetaKey: CRAWL_KEY,
  lastApplyMono: MONO - 10 * MIN,
  inflight: 0,
  ...over,
});

beforeEach(() => __resetSyncActivityForTests());

describe("gates, in contract order", () => {
  const converged = withSlot(baseState({ [A]: row(A), [B]: row(B) }));

  it("a converged replica passes on the digest short circuit", () => {
    expect(evaluateInboxCompare(converged, ctx())).toMatchObject({ kind: "clean", short_circuit: true, epoch: EPOCH });
  });

  it("a team slot is uncovered, never compared", () => {
    expect(evaluateInboxCompare(converged, ctx({ scopeKey: "team:t1" }))).toEqual({ kind: "skip", reason: "scope_uncovered" });
  });

  it("no payload yet is the cold case", () => {
    expect(evaluateInboxCompare({ ...converged, sessionsProjection: {} }, ctx())).toEqual({ kind: "skip", reason: "cold_replica" });
  });

  it("gate 1: a null digest (INBOX_DIGEST_DISABLED) disables the compare before any other gate", () => {
    const s = withSlot(converged, { set_digest: null, v: 0 });
    expect(evaluateInboxCompare(s, ctx())).toEqual({ kind: "disabled" });
  });

  it("gate 2: a payload from another projection version is skipped and names its version", () => {
    const s = withSlot(converged, { v: INBOX_PROJECTION_VERSION + 1 });
    expect(evaluateInboxCompare(s, ctx())).toEqual({ kind: "skip", reason: "version_skew", payload_v: INBOX_PROJECTION_VERSION + 1 });
  });

  it("gate 3: payload age on the receipt clock", () => {
    const r = evaluateInboxCompare(converged, ctx({ nowMono: MONO + INBOX_COMPARE_MAX_PAYLOAD_AGE_MS + 1 }));
    expect(r).toMatchObject({ kind: "skip", reason: "stale_payload", payload_age_ms: INBOX_COMPARE_MAX_PAYLOAD_AGE_MS + 1 });
    expect(evaluateInboxCompare(converged, ctx({ nowMono: MONO + INBOX_COMPARE_MAX_PAYLOAD_AGE_MS })).kind).toBe("clean");
  });

  it("gate 4: quiescence — an in-flight range/crawl/poll, a recent row apply, or a loading crawl", () => {
    expect(evaluateInboxCompare(converged, ctx({ inflight: 1 }))).toMatchObject({ kind: "skip", reason: "not_quiescent" });
    expect(evaluateInboxCompare(converged, ctx({ lastApplyMono: MONO + 1_000 - INBOX_COMPARE_QUIESCENT_MS + 1 }))).toMatchObject({ kind: "skip", reason: "not_quiescent" });
    expect(evaluateInboxCompare(converged, ctx({ lastApplyMono: MONO + 1_000 - INBOX_COMPARE_QUIESCENT_MS })).kind).toBe("clean");
    expect(evaluateInboxCompare({ ...converged, syncProgress: { sessions: { loading: true } } }, ctx())).toMatchObject({ kind: "skip", reason: "not_quiescent" });
  });

  it("gate 5: a replica whose completeness crawl has not stamped backfilledAt compares nothing", () => {
    expect(evaluateInboxCompare({ ...converged, syncMeta: {} }, ctx())).toMatchObject({ kind: "skip", reason: "cold_replica" });
    expect(evaluateInboxCompare(converged, ctx({ crawlMetaKey: null }))).toMatchObject({ kind: "skip", reason: "cold_replica" });
  });

  it("a capped member set is dark as a whole", () => {
    const s = withSlot(converged, { truncated: ["members"] });
    expect(evaluateInboxCompare(s, ctx())).toMatchObject({ kind: "skip", reason: "truncated_windows" });
  });

  it("the skip alphabet is exactly the six named causes", () => {
    expect([...INBOX_COMPARE_SKIPS]).toEqual(["stale_payload", "version_skew", "not_quiescent", "cold_replica", "truncated_windows", "scope_uncovered"]);
  });
});

describe("the per-row diff", () => {
  it("with a declared overlay active the digest cannot short-circuit, but a converged set is still clean", () => {
    const s = withSlot(baseState({ [A]: row(A), [B]: row(B) }, { currentSessionId: A }));
    expect(evaluateInboxCompare(s, ctx())).toMatchObject({ kind: "clean", short_circuit: false });
  });

  it("decomposes into missing, extra, bucket_deltas and fold_deltas", () => {
    const F = cid("f");
    const full = baseState({
      [A]: row(A),
      [B]: row(B),
      [C]: row(C, { agent_status: "working", is_idle: false, updated_at: EPOCH - MIN }),
      [D]: row(D, { updated_at: EPOCH - 20 * H }), // the row AT the 12h gap: the cut, never folded itself
      [F]: row(F, { updated_at: EPOCH - 21 * H }), // strictly below the cut
    });
    const slot = serverSlot(full);
    expect(slot.stamps[F].below_fold).toBe(true);
    // The replica: lacks B (missing), holds an unstamped E (extra), sees C
    // idle (bucket delta) and F fresh (fold delta).
    const E = cid("e");
    const replica = baseState({
      [A]: row(A),
      [C]: row(C),
      [D]: row(D, { updated_at: EPOCH - 20 * H }),
      [E]: row(E),
      [F]: row(F, { updated_at: EPOCH - 5 * MIN }),
    }, { sessionsProjection: { mine: slot } });
    const r = evaluateInboxCompare(replica, ctx());
    expect(r.kind).toBe("diff");
    if (r.kind !== "diff") return;
    expect(r.diff.missing).toEqual([B]);
    expect(r.diff.extra).toEqual([E]);
    expect(r.diff.bucket_deltas).toEqual([C]);
    expect(r.diff.fold_deltas).toEqual([F]);
    expect(r.set_digest).toBe(slot.set_digest);
  });

  it("drops ids a declared overlay touches (focused, revive, queued send, create stub)", () => {
    const full = baseState({ [A]: row(A), [B]: row(B, { agent_status: "working", is_idle: false }) });
    const slot = serverSlot(full);
    // The replica disagrees on B's bucket — but B is focused, then revived,
    // then has a queued send: every declared overlay carves it out.
    const disagree = baseState({ [A]: row(A), [B]: row(B) }, { sessionsProjection: { mine: slot } });
    expect(evaluateInboxCompare(disagree, ctx()).kind).toBe("diff");
    expect(evaluateInboxCompare({ ...disagree, currentSessionId: B }, ctx()).kind).toBe("clean");
    expect(evaluateInboxCompare({ ...disagree, blockedReviveRequestedAt: { [B]: NOW - 1_000 } }, ctx()).kind).toBe("clean");
    expect(evaluateInboxCompare({ ...disagree, sessionsWithQueuedMessages: new Set([B]) }, ctx()).kind).toBe("clean");
    expect(evaluateInboxCompare({ ...disagree, pendingSessionCreates: { [B]: true } }, ctx()).kind).toBe("clean");
  });

  it("a truncated window excuses a membership difference, never a bucket delta on a row both sides selected", () => {
    // B is a member through the recent window ONLY, selected on BOTH sides.
    // The server stamps it working; the replica reads it idle. The overflow
    // flag does not hide that: the cap explains a row one side cut, not a
    // verdict both sides hold (a busy account overflows recent every day, and
    // hiding every recent-only row blinded the proof — prod, 2026-09-01).
    const full = baseState({ [A]: row(A), [B]: row(B, { agent_status: "working", is_idle: false }) });
    const held = { [A]: row(A), [B]: row(B) };
    expect(evaluateInboxCompare(baseState(held, { sessionsProjection: { mine: serverSlot(full, { truncated: ["recent"] }) } }), ctx()))
      .toMatchObject({ kind: "diff", diff: { bucket_deltas: [B] } });
    // An EXTRA the replica selects through the overflowed window alone is the
    // cap's doing and stays dark.
    const extra = baseState({ [A]: row(A), [B]: row(B) }, { sessionsProjection: { mine: serverSlot(baseState({ [A]: row(A) }), { truncated: ["recent"] }) } });
    expect(evaluateInboxCompare(extra, ctx()).kind).toBe("clean");
    // Without the flag the same extra is reported.
    const strictExtra = baseState({ [A]: row(A), [B]: row(B) }, { sessionsProjection: { mine: serverSlot(baseState({ [A]: row(A) })) } });
    expect(evaluateInboxCompare(strictExtra, ctx())).toMatchObject({ kind: "diff", diff: { extra: [B] } });
  });

  it("a stamped id the replica does not HOLD is missing even under an overflow flag — the heal hydrates it, then the window carve-out applies", () => {
    const pinnedOnly = { updated_at: EPOCH - 40 * DAY, inbox_pinned_at: EPOCH - 40 * DAY };
    const full = baseState({ [A]: row(A), [B]: row(B, pinnedOnly) });
    const slot = serverSlot(full, { truncated: ["pinned"] });
    const lacking = baseState({ [A]: row(A) }, { sessionsProjection: { mine: slot } });
    expect(evaluateInboxCompare(lacking, ctx())).toMatchObject({ kind: "diff", diff: { missing: [B] } });
    const healed = baseState({ [A]: row(A), [B]: row(B, pinnedOnly) }, { sessionsProjection: { mine: slot } });
    expect(evaluateInboxCompare(healed, ctx()).kind).toBe("clean");
  });

  it("drops foreign-run rows only when foreign_scan fired", () => {
    const OTHER = "o".repeat(32);
    const full = baseState({ [A]: row(A), [B]: row(B, { user_id: OTHER, owned_by_me: true, agent_status: "working", is_idle: false }) });
    const slot = serverSlot(full);
    const replica = baseState({ [A]: row(A), [B]: row(B, { user_id: OTHER, owned_by_me: true }) }, { sessionsProjection: { mine: slot } });
    expect(evaluateInboxCompare(replica, ctx())).toMatchObject({ kind: "diff", diff: { bucket_deltas: [B] } });
    const flagged = { ...replica, sessionsProjection: { mine: { ...slot, truncated: ["foreign_scan" as const] } } };
    expect(evaluateInboxCompare(flagged, ctx()).kind).toBe("clean");
  });

  it("show-old does not change the comparison (it only names the headline tally)", () => {
    const rows = { [A]: row(A), [D]: row(D, { updated_at: EPOCH - 20 * H }) };
    const off = withSlot(baseState(rows));
    const on = { ...off, clientState: { ui: { inbox_scope: "mine" as const, inbox_show_old: true } } };
    expect(evaluateInboxCompare(off, ctx()).kind).toBe("clean");
    expect(evaluateInboxCompare(on, ctx()).kind).toBe("clean");
  });
});

// ── The stateful loop ───────────────────────────────────────────────────────

type Harness = {
  comparer: ReturnType<typeof createInboxDigestComparer>;
  events: Array<{ event: string; props: Record<string, unknown> }>;
  fetched: string[][];
  probes: number;
  clock: { now: number; mono: number };
  flushHeal: () => Promise<void>;
};

function harness(over: Partial<InboxDigestComparerIO> = {}): Harness {
  const events: Harness["events"] = [];
  const fetched: string[][] = [];
  const clock = { now: NOW, mono: MONO + 1_000 };
  let scheduled: Array<() => void> = [];
  const h: Harness = {
    events,
    fetched,
    probes: 0,
    clock,
    comparer: null as any,
    flushHeal: async () => {
      const fns = scheduled;
      scheduled = [];
      for (const fn of fns) fn();
      // Let the async heal chain settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  h.comparer = createInboxDigestComparer({
    platform: "test",
    track: (event, props) => events.push({ event, props }),
    fetchByIds: async (ids) => {
      fetched.push(ids);
    },
    probeOverlay: async () => {
      h.probes++;
    },
    crawlMetaKeyFor: (meId) => (meId ? `sessions:v2:inbox:${meId}` : null),
    now: () => clock.now,
    nowMono: () => clock.mono,
    random: () => 0.5,
    schedule: (fn) => {
      scheduled.push(fn);
      return () => {
        scheduled = scheduled.filter((f) => f !== fn);
      };
    },
    ...over,
  });
  return h;
}

// A replica that disagrees with its stamps: B stamped working, held idle.
function driftingState(epoch = EPOCH, receivedAtMono = MONO): InboxCompareState {
  const full = baseState({ [A]: row(A), [B]: row(B, { agent_status: "working", is_idle: false }) });
  const slot = serverSlot(full, { epoch, receivedAtMono });
  return baseState({ [A]: row(A), [B]: row(B) }, { sessionsProjection: { mine: slot } });
}
function missingState(epoch = EPOCH, receivedAtMono = MONO): InboxCompareState {
  const full = baseState({ [A]: row(A), [B]: row(B) });
  const slot = serverSlot(full, { epoch, receivedAtMono });
  return baseState({ [A]: row(A) }, { sessionsProjection: { mine: slot } });
}
function cleanState(epoch = EPOCH, receivedAtMono = MONO): InboxCompareState {
  return withSlot(baseState({ [A]: row(A), [B]: row(B) }), { epoch, receivedAtMono });
}

describe("the device clock never enters the comparison (C2)", () => {
  it("a quiet 'waiting' row whose trust TTL expires between the epoch and the tick compares clean", () => {
    // The server stamped it dormant at the epoch (an inferred "waiting" no
    // open_tasks report vouches for decays after STATUS_TRUST_TTL_MS); at the
    // tick, 100s later, the same decay would file it needs_input. The compare
    // must evaluate at the epoch, so this is not a bucket delta.
    const waiting = row(A, { agent_status: "waiting", updated_at: EPOCH + 100_000 - STATUS_TRUST_TTL_MS });
    const state = withSlot(baseState({ [A]: waiting, [B]: row(B) }));
    expect(state.sessionsProjection.mine.stamps[A].bucket).toBe("dormant");
    const tick = ctx({ now: EPOCH + 110_000, nowMono: MONO + 60_000 });
    expect(evaluateInboxCompare(state, tick)).toMatchObject({ kind: "clean" });
  });
});

describe("persistence rule (C6)", () => {
  it("two unrelated transient diffs at consecutive epochs are not drift; the same id twice is", () => {
    const h = harness();
    // Epoch E: B disagrees. Epoch E+1: only C disagrees (B healed itself).
    const first = baseState({ [A]: row(A), [B]: row(B, { agent_status: "working", is_idle: false }), [C]: row(C) });
    const atE = baseState({ [A]: row(A), [B]: row(B), [C]: row(C) }, { sessionsProjection: { mine: serverSlot(first, { epoch: EPOCH }) } });
    const second = baseState({ [A]: row(A), [B]: row(B), [C]: row(C, { agent_status: "working", is_idle: false }) });
    const atE1 = baseState({ [A]: row(A), [B]: row(B), [C]: row(C) }, { sessionsProjection: { mine: serverSlot(second, { epoch: EPOCH + MIN, receivedAtMono: MONO + 30_000 }) } });
    expect(h.comparer.tick(atE).kind).toBe("diff");
    h.clock.mono += 30_000;
    expect(h.comparer.tick(atE1).kind).toBe("diff");
    expect(h.comparer.counters().mismatches).toBe(0);
    expect(h.events).toEqual([]);
    // Epoch E+2: C still disagrees — the same id, the same category: drift.
    const atE2 = baseState({ [A]: row(A), [B]: row(B), [C]: row(C) }, { sessionsProjection: { mine: serverSlot(second, { epoch: EPOCH + 2 * MIN, receivedAtMono: MONO + 60_000 }) } });
    h.clock.mono += 30_000;
    expect(h.comparer.tick(atE2).kind).toBe("diff");
    expect(h.comparer.counters().mismatches).toBe(1);
    expect(h.events.map((e) => e.event)).toEqual(["inbox_drift"]);
    expect(h.events[0].props.bucket_deltas).toBe(1);
  });

  it("a diff counts only when it persists across two compares at distinct payload epochs", async () => {
    const h = harness();
    // Same epoch twice: a race, not divergence.
    expect(h.comparer.tick(driftingState()).kind).toBe("diff");
    expect(h.comparer.tick(driftingState()).kind).toBe("diff");
    expect(h.comparer.counters().mismatches).toBe(0);
    expect(h.events).toEqual([]);
    // A later payload epoch with the diff still present: drift.
    h.clock.mono += 30_000;
    h.comparer.tick(driftingState(EPOCH + MIN, MONO + 30_000));
    expect(h.comparer.counters().mismatches).toBe(1);
    expect(h.comparer.counters().checks).toBe(3);
  });

  it("a clean compare in between resets the persistence", () => {
    const h = harness();
    h.comparer.tick(driftingState());
    h.comparer.tick(cleanState());
    h.comparer.tick(driftingState(EPOCH + MIN, MONO));
    expect(h.comparer.counters().mismatches).toBe(0);
  });
});

describe("heal (C7)", () => {
  it("missing ids hydrate by id then ONE overlay probe; counted separately", async () => {
    const h = harness();
    h.comparer.tick(missingState());
    h.comparer.tick(missingState(EPOCH + MIN));
    await h.flushHeal();
    expect(h.fetched).toEqual([[B]]);
    expect(h.probes).toBe(1);
    expect(h.comparer.counters()).toMatchObject({ heals: 1, heals_missing: 1, mismatches: 1 });
  });

  it("bucket/fold deltas on held rows re-read the row by id AND probe once — never a working-set refetch", async () => {
    // The probe heals a stale FACT; the byIds read heals a stale BASE field
    // (a settle verdict a phone's folded copy never received — prod,
    // 2026-09-01). Both ride one heal, inside one budget slot.
    const h = harness();
    h.comparer.tick(driftingState());
    h.comparer.tick(driftingState(EPOCH + MIN));
    await h.flushHeal();
    expect(h.fetched).toEqual([[B]]);
    expect(h.probes).toBe(1);
    expect(h.comparer.counters()).toMatchObject({ heals: 1, heals_missing: 1 });
  });

  it("extras are re-read by id and reported, never deleted", async () => {
    const h = harness();
    const full = baseState({ [A]: row(A) });
    const slot = serverSlot(full);
    const extra = baseState({ [A]: row(A), [B]: row(B) }, { sessionsProjection: { mine: slot } });
    h.comparer.tick(extra);
    h.comparer.tick({ ...extra, sessionsProjection: { mine: { ...slot, epoch: EPOCH + MIN } } });
    await h.flushHeal();
    // The heal asks the authorized byIds channel for the extra: a row the
    // replica holds wrong (a settled pin lock over a remote kill) lands its
    // fields; a row the server does not return is left exactly as it was.
    expect(h.fetched).toEqual([[B]]);
    expect(h.events.find((e) => e.event === "inbox_drift")?.props).toMatchObject({ extra: 1, missing: 0 });
    expect(extra.sessions[B]).toBeDefined();
  });

  it("budget: three heals per fixed window, the fourth latches healing off and emits inbox_drift_persistent", async () => {
    const h = harness();
    let epoch = EPOCH;
    const confirm = async () => {
      h.comparer.tick(driftingState(epoch));
      epoch += MIN;
      h.comparer.tick(driftingState(epoch));
      epoch += MIN;
      await h.flushHeal();
    };
    for (let i = 0; i < INBOX_HEAL_BUDGET; i++) await confirm();
    expect(h.probes).toBe(INBOX_HEAL_BUDGET);
    expect(h.comparer.healLatched()).toBe(false);
    await confirm();
    expect(h.probes).toBe(INBOX_HEAL_BUDGET); // no fourth heal
    expect(h.comparer.healLatched()).toBe(true);
    expect(h.events.filter((e) => e.event === "inbox_drift_persistent")).toHaveLength(1);
    // Latched stays latched, even past the window: only a reload rearms it.
    h.clock.now += INBOX_HEAL_WINDOW_MS * 2;
    await confirm();
    expect(h.probes).toBe(INBOX_HEAL_BUDGET);
    expect(h.events.filter((e) => e.event === "inbox_drift_persistent")).toHaveLength(1);
    // Mismatches keep counting under the latch — the metric never goes dark.
    expect(h.comparer.counters().mismatches).toBe(INBOX_HEAL_BUDGET + 2);
  });

  it("a fresh window rearms the budget when the latch has not fired", async () => {
    const h = harness();
    let epoch = EPOCH;
    const confirm = async () => {
      h.comparer.tick(driftingState(epoch));
      epoch += MIN;
      h.comparer.tick(driftingState(epoch));
      epoch += MIN;
      await h.flushHeal();
    };
    for (let i = 0; i < INBOX_HEAL_BUDGET; i++) await confirm();
    h.clock.now += INBOX_HEAL_WINDOW_MS;
    await confirm();
    expect(h.probes).toBe(INBOX_HEAL_BUDGET + 1);
    expect(h.comparer.healLatched()).toBe(false);
  });

  it("heals are jittered through the injected scheduler", async () => {
    const delays: number[] = [];
    const h = harness({
      schedule: (fn, ms) => {
        delays.push(ms);
        fn();
        return () => {};
      },
      random: () => 0.25,
    });
    h.comparer.tick(driftingState());
    h.comparer.tick(driftingState(EPOCH + MIN));
    expect(delays).toEqual([2_500]);
  });
});

describe("telemetry (C7)", () => {
  it("inbox_drift carries counts only, never ids, deduped per digest change", async () => {
    const h = harness();
    h.comparer.tick(driftingState());
    h.comparer.tick(driftingState(EPOCH + MIN));
    await h.flushHeal();
    const drift = h.events.filter((e) => e.event === "inbox_drift");
    expect(drift).toHaveLength(1);
    expect(drift[0].props).toMatchObject({ missing: 0, extra: 0, bucket_deltas: 1, fold_deltas: 0, scope: "mine", platform: "test" });
    expect(JSON.stringify(drift[0].props)).not.toContain(B);
    expect(typeof drift[0].props.payload_age_ms).toBe("number");
    // Same digest again → no second event; a changed digest → a new one.
    h.comparer.tick(driftingState(EPOCH + 2 * MIN));
    h.comparer.tick(driftingState(EPOCH + 3 * MIN));
    await h.flushHeal();
    expect(h.events.filter((e) => e.event === "inbox_drift")).toHaveLength(1);
    h.comparer.tick(missingState(EPOCH + 4 * MIN));
    h.comparer.tick(missingState(EPOCH + 5 * MIN));
    await h.flushHeal();
    expect(h.events.filter((e) => e.event === "inbox_drift")).toHaveLength(2);
  });

  it("inbox_digest_version_skew fires once per distinct payload version", () => {
    const h = harness();
    const skew = withSlot(cleanState(), { v: INBOX_PROJECTION_VERSION + 1 });
    h.comparer.tick(skew);
    h.comparer.tick(skew);
    expect(h.events.filter((e) => e.event === "inbox_digest_version_skew")).toHaveLength(1);
    expect(h.events[0].props).toMatchObject({ payload_v: INBOX_PROJECTION_VERSION + 1, client_v: INBOX_PROJECTION_VERSION });
    h.comparer.tick(withSlot(cleanState(), { v: INBOX_PROJECTION_VERSION + 2 }));
    expect(h.events.filter((e) => e.event === "inbox_digest_version_skew")).toHaveLength(2);
    expect(h.comparer.counters().skips.version_skew).toBe(3);
  });

  it("inbox_digest_heartbeat fires hourly with every counter, zeros included, then resets", () => {
    const h = harness();
    h.comparer.tick(cleanState()); // first tick arms the heartbeat clock
    h.comparer.tick(cleanState());
    h.comparer.tick({ ...cleanState(), sessionsProjection: {} }); // cold_replica
    h.comparer.tick(withSlot(cleanState(), { set_digest: null })); // disabled
    h.clock.now += INBOX_HEARTBEAT_INTERVAL_MS;
    h.comparer.tick(cleanState());
    const hb = h.events.filter((e) => e.event === "inbox_digest_heartbeat");
    expect(hb).toHaveLength(1);
    expect(hb[0].props).toMatchObject({
      scope: "mine",
      platform: "test",
      checks: 2,
      mismatches: 0,
      heals: 0,
      heals_missing: 0,
      disabled: 1,
      probes: 0,
      skips: { stale_payload: 0, version_skew: 0, not_quiescent: 0, cold_replica: 1, truncated_windows: 0, scope_uncovered: 0 },
    });
    expect(typeof hb[0].props.max_payload_age_ms).toBe("number");
    // Reset after the emit: the tick that emitted counts toward the next hour.
    expect(h.comparer.counters()).toMatchObject({ checks: 1, disabled: 0 });
    expect(h.comparer.counters().skips.cold_replica).toBe(0);
  });

  it("a team slot counts as uncovered scope on every tick", () => {
    const h = harness();
    const s = cleanState();
    h.comparer.tick({ ...s, sessionsProjection: { ...s.sessionsProjection, "team:t1": s.sessionsProjection.mine } });
    expect(h.comparer.counters().skips.scope_uncovered).toBe(1);
    expect(h.comparer.counters().checks).toBe(1);
  });

  it("max_payload_age_ms tracks the oldest payload seen, skipped or checked", () => {
    const h = harness();
    h.comparer.tick(cleanState());
    h.clock.mono = MONO + INBOX_COMPARE_MAX_PAYLOAD_AGE_MS + 5_000;
    h.comparer.tick(cleanState());
    expect(h.comparer.counters().max_payload_age_ms).toBe(INBOX_COMPARE_MAX_PAYLOAD_AGE_MS + 5_000);
    expect(h.comparer.counters().skips.stale_payload).toBe(1);
  });
});

describe("kill switch (C8) and the stale-payload probe (C2)", () => {
  it("a null digest turns off compare, heal AND the stale probe", async () => {
    const h = harness();
    const off = withSlot(driftingState(), { set_digest: null, receivedAtMono: MONO - INBOX_PROBE_PAYLOAD_AGE_MS * 2 });
    h.comparer.tick(off);
    h.comparer.tick({ ...off, sessionsProjection: { mine: { ...off.sessionsProjection.mine, epoch: EPOCH + MIN } } });
    await h.flushHeal();
    expect(h.probes).toBe(0);
    expect(h.fetched).toEqual([]);
    expect(h.comparer.counters().disabled).toBe(2);
    expect(h.events).toEqual([]);
  });

  it("a payload older than five minutes gets one probe on the slow budget", async () => {
    const h = harness();
    const stale = cleanState(EPOCH, MONO + 1_000 - INBOX_PROBE_PAYLOAD_AGE_MS - 1);
    expect(h.comparer.tick(stale)).toMatchObject({ kind: "skip", reason: "stale_payload" });
    expect(h.probes).toBe(1);
    await h.flushHeal(); // let the probe settle
    h.comparer.tick(stale);
    expect(h.probes).toBe(1); // budgeted
    h.clock.now += INBOX_PROBE_MIN_INTERVAL_MS;
    h.comparer.tick(stale);
    expect(h.probes).toBe(2);
    expect(h.comparer.counters().probes).toBe(2);
  });

  it("dispose cancels a scheduled heal and stops the loop", async () => {
    const h = harness();
    h.comparer.tick(driftingState());
    h.comparer.tick(driftingState(EPOCH + MIN));
    h.comparer.dispose();
    await h.flushHeal();
    expect(h.probes).toBe(0);
    expect(h.comparer.tick(cleanState())).toEqual({ kind: "disabled" });
  });
});

describe("the bucket alphabet in stamps", () => {
  it("every stamped bucket the server can emit is comparable", () => {
    const buckets: InboxBucket[] = ["questions", "pinned", "new", "needs_input", "done", "dormant", "working", "hidden", "dismissed", "stashed"];
    const s = withSlot(baseState({ [A]: row(A) }));
    for (const b of buckets) {
      const stamped = { ...s, sessionsProjection: { mine: { ...s.sessionsProjection.mine, stamps: { [A]: { ...s.sessionsProjection.mine.stamps[A], bucket: b } } } } };
      const r = evaluateInboxCompare(stamped, ctx());
      expect(r.kind === "clean" || (r.kind === "diff" && r.diff.bucket_deltas.length === 1)).toBe(true);
    }
  });
});
