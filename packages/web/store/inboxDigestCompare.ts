// THE DIGEST COMPARE — anti-entropy for the inbox replica
// (docs/architecture/sync-convergence.md C6 compare, C7 heal + telemetry,
// C8 kill switch).
//
// Every replica client computes its own inbox placement from its replica with
// the shared module; the server runs the SAME module over canonical state and
// ships the result as checking data (the per-scope stamp buffer,
// `sessionsProjection`). This module diffs the two, per row, at the payload's
// epoch, and turns disagreement into a metric plus a bounded, targeted heal.
// It is the ONE reader of the stamp buffer besides its owner (a source guard
// holds that), and nothing here is a render source.
//
// Pure core, stateful shell: `evaluateInboxCompare` is a function of store
// state and a clock; `createInboxDigestComparer` wraps it with the
// persistence rule, the heal budget and latch, the stale-payload probe
// scheduler and the telemetry counters, all behind an injectable IO surface so
// the whole loop is unit-testable without React, Convex or timers.
import {
  INBOX_PROJECTION_VERSION,
  inWorkingSet,
  isWorkingSetWindow,
  type WorkingSetWindow,
} from "@codecast/shared/contracts";
import {
  anyOverlayActive,
  collectInboxOverlayDeps,
  isOverlayAffected,
  type InboxOverlayState,
} from "./inboxOverlays";
import {
  INBOX_PAYLOAD_FRESH_MS,
  placeInboxRows,
  projectReplicaInbox,
  useInboxStore,
  type PlaceInboxState,
  type SessionsProjectionSlot,
} from "./inboxStore";
import { lastSyncApplyMono, monotonicNow, syncInflightCount } from "./syncActivity";

// ── Constants (the pinned contract) ─────────────────────────────────────────

/** The coarse tick the compare runs on. */
export const INBOX_COMPARE_TICK_MS = 15_000;
/** A payload older than this (receipt clock) is skipped: stale_payload. The
 *  same bound past which the store stops trusting the payload's facts
 *  (overlayCoverage), so the compare never runs over a sweep-adjusted row. */
export const INBOX_COMPARE_MAX_PAYLOAD_AGE_MS = INBOX_PAYLOAD_FRESH_MS;
/** Past this age a quiet scope gets ONE budgeted overlay probe (C2). */
export const INBOX_PROBE_PAYLOAD_AGE_MS = 300_000;
/** The stale-payload probe's slow budget: at most one per this window. */
export const INBOX_PROBE_MIN_INTERVAL_MS = 300_000;
/** Quiescence: no COMMITTED row apply for this settle window, nothing in
 *  flight. A short window, not a multiple of the tick: on a busy account a
 *  real row change lands every 20 to 30 seconds (several agents streaming),
 *  so "N ticks of silence" never held in prod and the compare stayed dark.
 *  A steady-state apply is not catch-up — the overlay re-executes on the same
 *  server change and re-stamps — so the gate only needs to outlast the pair
 *  of pushes (base row and overlay) one server change produces. */
export const INBOX_COMPARE_QUIESCENT_MS = 5_000;
/** Heal budget: this many heals per fixed window, then the latch. */
export const INBOX_HEAL_BUDGET = 3;
export const INBOX_HEAL_WINDOW_MS = 600_000;
/** Heals are jittered inside this bound so a fleet never heals in lockstep. */
export const INBOX_HEAL_JITTER_MS = 10_000;
/** The heartbeat cadence. */
export const INBOX_HEARTBEAT_INTERVAL_MS = 3_600_000;

// The six named skip causes (C7 heartbeat), in contract order. Every skipped
// tick names exactly one, so "no checks ran" always says why.
export const INBOX_COMPARE_SKIPS = [
  "stale_payload",
  "version_skew",
  "not_quiescent",
  "cold_replica",
  "truncated_windows",
  "scope_uncovered",
] as const;
export type InboxCompareSkip = (typeof INBOX_COMPARE_SKIPS)[number];

// ── Types ───────────────────────────────────────────────────────────────────

// The store-state subset the compare reads. Structural: the store satisfies
// it, and tests hand in plain objects.
export type InboxCompareState = PlaceInboxState & {
  sessionsProjection: Record<string, SessionsProjectionSlot>;
  pending: InboxOverlayState["pending"];
  syncMeta: Record<string, { backfilledAt?: number } | undefined>;
  syncProgress: Record<string, { loading: boolean } | undefined>;
};

/** The per-row diff. Ids stay INSIDE the client (heal targets); telemetry
 *  only ever sees the counts. */
export type InboxDriftDiff = {
  /** Stamped ids the replica does not select (or hold). */
  missing: string[];
  /** Replica members the stamps lack. */
  extra: string[];
  /** Both sides hold the row; the bucket differs. */
  bucket_deltas: string[];
  /** Same bucket; the fold bit differs. */
  fold_deltas: string[];
};

export function isDriftDiffEmpty(d: InboxDriftDiff): boolean {
  return d.missing.length === 0 && d.extra.length === 0 && d.bucket_deltas.length === 0 && d.fold_deltas.length === 0;
}

// The ids that appear in BOTH diffs under the same category — the part of a
// diff that persisted from one payload epoch to the next.
export function intersectDriftDiff(a: InboxDriftDiff, b: InboxDriftDiff): InboxDriftDiff {
  const keep = (xs: string[], ys: string[]) => {
    const set = new Set(ys);
    return xs.filter((id) => set.has(id));
  };
  return {
    missing: keep(a.missing, b.missing),
    extra: keep(a.extra, b.extra),
    bucket_deltas: keep(a.bucket_deltas, b.bucket_deltas),
    fold_deltas: keep(a.fold_deltas, b.fold_deltas),
  };
}

export type InboxCompareOutcome =
  /** Kill switch (C8): the payload carries no digest. Compare AND heal off. */
  | { kind: "disabled" }
  | { kind: "skip"; reason: InboxCompareSkip; payload_v?: number; payload_age_ms?: number }
  | { kind: "clean"; epoch: number; short_circuit: boolean; payload_age_ms: number }
  | { kind: "diff"; epoch: number; diff: InboxDriftDiff; payload_age_ms: number; set_digest: string };

export type InboxCompareContext = {
  /** Wall clock: overlay bounds ONLY. The projection itself is evaluated at
   *  the payload's epoch (C2) — the device clock never enters the comparison. */
  now: number;
  /** Receipt clock: payload age. */
  nowMono: number;
  /** syncMeta key of the sessions completeness crawl; null with no principal. */
  crawlMetaKey: string | null;
  lastApplyMono: number;
  inflight: number;
  /** Which stamp slot to evaluate. Only "mine" is covered (C4). */
  scopeKey?: string;
};

function anyCrawlLoading(progress: InboxCompareState["syncProgress"]): boolean {
  for (const ns in progress) if (progress[ns]?.loading) return true;
  return false;
}

// ── The pure compare (C6) ───────────────────────────────────────────────────

// Gates in contract order, then the procedure: evaluate the shared module AT
// THE PAYLOAD'S EPOCH over the replica; digest short-circuit only when no
// declared overlay is active; otherwise the per-row diff with the three
// carve-outs (overlay-affected ids, rows whose every window overflowed,
// foreign rows under a fired foreign_scan).
export function evaluateInboxCompare(state: InboxCompareState, ctx: InboxCompareContext): InboxCompareOutcome {
  const scopeKey = ctx.scopeKey ?? "mine";
  // Gate 6 first when the slot is not the personal one: team scope stamps
  // ship for rendering freshness but the replica lacks the visibility inputs
  // to select a team working set — counted, never compared.
  if (scopeKey !== "mine") return { kind: "skip", reason: "scope_uncovered" };
  const slot = state.sessionsProjection[scopeKey];
  // No payload yet: the replica has nothing to compare against — the cold
  // case, same as an unstamped crawl.
  if (!slot) return { kind: "skip", reason: "cold_replica" };
  // Gate 1: the kill switch.
  if (slot.set_digest == null) return { kind: "disabled" };
  // Gate 2: the version gate — deploy skew is silence plus a metric.
  if (slot.v !== INBOX_PROJECTION_VERSION) return { kind: "skip", reason: "version_skew", payload_v: slot.v };
  // Gate 3: payload age on the receipt clock.
  const payload_age_ms = Math.max(0, ctx.nowMono - slot.receivedAtMono);
  if (payload_age_ms > INBOX_COMPARE_MAX_PAYLOAD_AGE_MS) return { kind: "skip", reason: "stale_payload", payload_age_ms };
  // Gate 4: applier quiescence.
  if (ctx.inflight > 0 || ctx.nowMono - ctx.lastApplyMono < INBOX_COMPARE_QUIESCENT_MS || anyCrawlLoading(state.syncProgress)) {
    return { kind: "skip", reason: "not_quiescent", payload_age_ms };
  }
  // Gate 5: the replica can honestly claim the set only after the
  // completeness crawl stamped backfilledAt.
  if (!ctx.crawlMetaKey || !state.syncMeta[ctx.crawlMetaKey]?.backfilledAt) {
    return { kind: "skip", reason: "cold_replica", payload_age_ms };
  }
  // A capped MEMBER set (team member caps) is dark as a whole, not per window.
  if (slot.truncated.includes("members") || slot.truncated.includes("member_rows")) {
    return { kind: "skip", reason: "truncated_windows", payload_age_ms };
  }

  // The procedure. The replica's projection at the payload's epoch — `now`
  // is the epoch too, so the trust decay is applied exactly where the server
  // applied it (see projectReplicaInbox).
  const focusedId = state.currentSessionId ?? null;
  const { proj, rowById, adapted } = projectReplicaInbox(state, { scope: "mine", focusedId, epoch: slot.epoch, now: slot.epoch, nowMono: ctx.nowMono });
  const deps = collectInboxOverlayDeps(
    {
      sessions: state.sessions,
      pending: state.pending,
      pendingMessages: state.pendingMessages,
      pendingSessionCreates: state.pendingSessionCreates ?? {},
      currentSessionId: focusedId,
      sessionsWithQueuedMessages: state.sessionsWithQueuedMessages,
      blockedReviveRequestedAt: state.blockedReviveRequestedAt ?? {},
    },
    ctx.now,
  );
  if (!anyOverlayActive(deps) && proj.set_digest === slot.set_digest) {
    return { kind: "clean", epoch: slot.epoch, short_circuit: true, payload_age_ms };
  }

  // Per-row diff with the carve-outs.
  const truncatedWindows = new Set<WorkingSetWindow>();
  for (const t of slot.truncated) if (isWorkingSetWindow(t)) truncatedWindows.add(t);
  for (const t of proj.truncated) if (isWorkingSetWindow(t)) truncatedWindows.add(t);
  const foreignScan = slot.truncated.includes("foreign_scan");
  const meId = state.currentUser?._id?.toString?.() ?? null;
  // A truncated window excuses a MEMBERSHIP difference only (a row the cap cut
  // on one side), never a bucket or fold difference on a row both sides
  // selected: on a busy account the recent window overflows every day, and
  // dropping every recent-only row made the proof blind to the rows that
  // matter (prod, 2026-09-01: four declared-done rows filed needs_input on
  // every replica behind a clean compare).
  // A foreign row under a budgeted foreign scan may not have been probed, so
  // its stamp is not a verdict: dark for facts AND membership.
  const droppedFacts = (id: string): boolean => {
    if (isOverlayAffected(id, deps)) return true;
    if (foreignScan && meId) {
      const row = rowById.get(id);
      if (row?.user_id && row.user_id !== meId) return true;
    }
    return false;
  };
  const droppedMembership = (id: string): boolean => {
    if (droppedFacts(id)) return true;
    if (truncatedWindows.size > 0) {
      // Eligibility windows, not just the selected ones: a held row the cap
      // cut on one side only is exactly the overflow case the flag names.
      const row = adapted.get(id);
      const windows = row ? inWorkingSet(row, slot.epoch) : proj.windows.get(id);
      if (windows && windows.length > 0 && windows.every((w) => truncatedWindows.has(w))) return true;
    }
    return false;
  };
  const diff: InboxDriftDiff = { missing: [], extra: [], bucket_deltas: [], fold_deltas: [] };
  const stamps = slot.stamps;
  for (const id in stamps) {
    const local = proj.placements.get(id);
    if (!local) {
      if (!droppedMembership(id)) diff.missing.push(id);
      continue;
    }
    if (droppedFacts(id)) continue;
    const stamp = stamps[id];
    if (local.bucket !== stamp.bucket) {
      diff.bucket_deltas.push(id);
      if (process.env.SIM_TRACE) {
        const a: any = adapted.get(id) ?? {};
        console.info("[inboxDigest] delta", JSON.stringify({ id: id.slice(0, 8), stamp: stamp.bucket, stamp_ws: stamp.work_state, local: local.bucket, local_ws: local.work_state, asking: stamp.asking, epoch: slot.epoch, adapted: { agent_status: a.agent_status, is_idle: a.is_idle, awaiting: a.awaiting_input, verdict: a.settle_verdict, thread: a.thread_state_status, killed: a.inbox_killed_at, pinned: a.inbox_pinned_at, dormant_at: a.inbox_dormant_at, armed: a.armed_trigger_kind, has_pending: a.has_pending_messages, updated_at: a.updated_at, msgs: a.message_count } }));
      }
    }
    else if (local.below_fold !== stamp.below_fold) diff.fold_deltas.push(id);
  }
  for (const id of proj.placements.keys()) {
    if (id in stamps || droppedMembership(id)) continue;
    diff.extra.push(id);
  }
  if (isDriftDiffEmpty(diff)) return { kind: "clean", epoch: slot.epoch, short_circuit: false, payload_age_ms };
  return { kind: "diff", epoch: slot.epoch, diff, payload_age_ms, set_digest: slot.set_digest };
}

// ── The stateful loop: persistence, heal, telemetry (C7) ────────────────────

export type InboxHeartbeatCounters = {
  checks: number;
  mismatches: number;
  heals: number;
  /** Heals that hydrated ids by getInboxSessionsByIds (missing bodies, re-read extras) — counted separately. */
  heals_missing: number;
  max_payload_age_ms: number;
  skips: Record<InboxCompareSkip, number>;
  /** Ticks the kill switch (set_digest null) turned away. */
  disabled: number;
  /** Stale-payload probes issued. */
  probes: number;
};

export function emptyHeartbeatCounters(): InboxHeartbeatCounters {
  const skips = {} as Record<InboxCompareSkip, number>;
  for (const k of INBOX_COMPARE_SKIPS) skips[k] = 0;
  return { checks: 0, mismatches: 0, heals: 0, heals_missing: 0, max_payload_age_ms: 0, skips, disabled: 0, probes: 0 };
}

export type InboxDigestComparerIO = {
  platform: string;
  track: (event: string, properties: Record<string, unknown>) => void;
  /** Hydrate exactly these ids into the store (the missing-bodies heal). */
  fetchByIds: (ids: string[]) => Promise<void>;
  /** One sessionsLiveness `_probe` applied through the overlay applier. */
  probeOverlay: () => Promise<void>;
  /** The sessions completeness-crawl syncMeta key for a principal. */
  crawlMetaKeyFor: (meId: string | null) => string | null;
  now?: () => number;
  nowMono?: () => number;
  random?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  onError?: (err: unknown) => void;
};

export type InboxDigestComparer = {
  /** One coarse tick. Returns the outcome so a caller (or test) can observe it. */
  tick: (state: InboxCompareState) => InboxCompareOutcome;
  /** The counters since the last heartbeat (read-only view for tests/dev). */
  counters: () => Readonly<InboxHeartbeatCounters>;
  healLatched: () => boolean;
  dispose: () => void;
};

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

export function createInboxDigestComparer(io: InboxDigestComparerIO): InboxDigestComparer {
  const now = io.now ?? (() => Date.now());
  const nowMono = io.nowMono ?? monotonicNow;
  const random = io.random ?? Math.random;
  const schedule = io.schedule ?? defaultSchedule;
  const onError = io.onError ?? ((err: unknown) => console.warn("[inboxDigest] heal failed", err));
  const base = { scope: "mine", platform: io.platform };

  let counters = emptyHeartbeatCounters();
  let heartbeatAt: number | null = null;
  // Persistence rule (C6): a diff counts only when the SAME id, in the same
  // category, persists across two consecutive compares at DISTINCT payload
  // epochs. Two unrelated transient diffs at consecutive payloads (a row
  // crossing a time boundary at each) are not drift.
  let pendingDiff: { epoch: number; diff: InboxDriftDiff } | null = null;
  // Heal budget (C7): fixed window, then the latch until reload.
  let healWindowStart = 0;
  let healsInWindow = 0;
  let latched = false;
  let healInFlight = false;
  let cancelHeal: (() => void) | null = null;
  let disposed = false;
  // Telemetry dedupe: one inbox_drift per changed digest value; one skew
  // event per distinct payload version.
  let lastDriftDigest: string | null = null;
  const skewSeen = new Set<number>();
  let lastStaleProbeAt = Number.NEGATIVE_INFINITY;
  let staleProbeInFlight = false;

  function heartbeat(t: number): void {
    if (heartbeatAt === null) {
      heartbeatAt = t;
      return;
    }
    if (t - heartbeatAt < INBOX_HEARTBEAT_INTERVAL_MS) return;
    heartbeatAt = t;
    // Zeros included: "no drift" must be distinguishable from "never ran".
    io.track("inbox_digest_heartbeat", { ...base, ...counters, skips: { ...counters.skips } });
    counters = emptyHeartbeatCounters();
  }

  // The stale-payload probe scheduler (C2): a frozen payload is where time
  // driven reclassification accumulates, so force one fresh execution on a
  // slow budget. Off with the kill switch (probe is compare machinery).
  function maybeProbeStale(state: InboxCompareState, t: number, tMono: number): void {
    const slot = state.sessionsProjection["mine"];
    if (!slot || slot.set_digest == null || staleProbeInFlight) return;
    if (tMono - slot.receivedAtMono <= INBOX_PROBE_PAYLOAD_AGE_MS) return;
    if (t - lastStaleProbeAt < INBOX_PROBE_MIN_INTERVAL_MS) return;
    lastStaleProbeAt = t;
    staleProbeInFlight = true;
    counters.probes++;
    io.probeOverlay()
      .catch(onError)
      .finally(() => {
        staleProbeInFlight = false;
      });
  }

  function runHeal(diff: InboxDriftDiff): void {
    healInFlight = true;
    // Missing bodies AND extras hydrate by id through the authorized byIds
    // channel. A missing row gets its body (its facts arrive with the probe's
    // overlay, which now has a row to land on). An extra is re-read: a row
    // the replica still counts but the server does not stamp is usually a
    // field the replica holds wrong — the two-replica simulation found a pin
    // lock re-asserting a local pin over a remote kill, and once the lock
    // settled no channel ever re-delivered the killed row, so the replica
    // kept a killed-but-pinned card forever. The authoritative row lands its
    // fields; a row the server no longer returns is left alone (deletion
    // truth is authorized absence) and stays a reported extra. A bucket or
    // fold delta on a held row is re-read by id TOO: a stale fact heals with
    // the probe, but the replica may hold a stale BASE field the overlay
    // never carries — a phone whose copy of a folded row predated its settle
    // verdict filed it needs_input against a done stamp, and a probe-only
    // heal could never move it (prod, 2026-09-01). One byIds fetch per heal,
    // bounded by the heal budget.
    const hydrate = [...diff.missing, ...diff.extra, ...diff.bucket_deltas, ...diff.fold_deltas];
    cancelHeal = schedule(() => {
      cancelHeal = null;
      (async () => {
        try {
          if (hydrate.length) {
            await io.fetchByIds(hydrate);
            counters.heals_missing++;
          }
          await io.probeOverlay();
          counters.heals++;
        } catch (err) {
          onError(err);
        } finally {
          healInFlight = false;
        }
      })();
    }, Math.floor(random() * INBOX_HEAL_JITTER_MS));
  }

  function onConfirmedDrift(outcome: Extract<InboxCompareOutcome, { kind: "diff" }>, t: number): void {
    counters.mismatches++;
    if (process.env.SIM_TRACE) console.info("[inboxDigest] drift", JSON.stringify(outcome.diff));
    if (outcome.set_digest !== lastDriftDigest) {
      lastDriftDigest = outcome.set_digest;
      io.track("inbox_drift", {
        ...base,
        missing: outcome.diff.missing.length,
        extra: outcome.diff.extra.length,
        bucket_deltas: outcome.diff.bucket_deltas.length,
        fold_deltas: outcome.diff.fold_deltas.length,
        payload_age_ms: outcome.payload_age_ms,
        epoch: outcome.epoch,
      });
    }
    if (latched || healInFlight) return;
    if (t - healWindowStart >= INBOX_HEAL_WINDOW_MS) {
      healWindowStart = t;
      healsInWindow = 0;
    }
    if (healsInWindow >= INBOX_HEAL_BUDGET) {
      // The fourth heal in a window: a same-version computation bug costs one
      // event per client, never a fleet of synchronized refetch storms.
      latched = true;
      io.track("inbox_drift_persistent", { ...base, heals_in_window: healsInWindow, window_ms: INBOX_HEAL_WINDOW_MS });
      return;
    }
    healsInWindow++;
    runHeal(outcome.diff);
  }

  function tick(state: InboxCompareState): InboxCompareOutcome {
    if (disposed) return { kind: "disabled" };
    const t = now();
    const tMono = nowMono();
    heartbeat(t);
    maybeProbeStale(state, t, tMono);
    // Coverage accounting for the team slot(s): stamps ship, nothing compares.
    for (const key in state.sessionsProjection) {
      if (key !== "mine") counters.skips.scope_uncovered++;
    }
    const meId = state.currentUser?._id?.toString?.() ?? null;
    const outcome = evaluateInboxCompare(state, {
      now: t,
      nowMono: tMono,
      crawlMetaKey: io.crawlMetaKeyFor(meId),
      lastApplyMono: lastSyncApplyMono(),
      inflight: syncInflightCount(),
    });
    switch (outcome.kind) {
      case "disabled":
        counters.disabled++;
        pendingDiff = null;
        break;
      case "skip":
        counters.skips[outcome.reason]++;
        if (outcome.reason === "version_skew" && outcome.payload_v !== undefined && !skewSeen.has(outcome.payload_v)) {
          skewSeen.add(outcome.payload_v);
          io.track("inbox_digest_version_skew", { ...base, payload_v: outcome.payload_v, client_v: INBOX_PROJECTION_VERSION });
        }
        if (outcome.payload_age_ms !== undefined) counters.max_payload_age_ms = Math.max(counters.max_payload_age_ms, outcome.payload_age_ms);
        break;
      case "clean":
        counters.checks++;
        counters.max_payload_age_ms = Math.max(counters.max_payload_age_ms, outcome.payload_age_ms);
        pendingDiff = null;
        break;
      case "diff":
        counters.checks++;
        counters.max_payload_age_ms = Math.max(counters.max_payload_age_ms, outcome.payload_age_ms);
        if (pendingDiff !== null && pendingDiff.epoch !== outcome.epoch) {
          // A later payload epoch: what persisted from the previous diff is
          // drift; anything that cleared in between was transient.
          const persisted = intersectDriftDiff(pendingDiff.diff, outcome.diff);
          pendingDiff = { epoch: outcome.epoch, diff: outcome.diff };
          if (!isDriftDiffEmpty(persisted)) {
            pendingDiff = null;
            onConfirmedDrift({ ...outcome, diff: persisted }, t);
          }
        } else if (pendingDiff === null) {
          pendingDiff = { epoch: outcome.epoch, diff: outcome.diff };
        }
        break;
    }
    return outcome;
  }

  return {
    tick,
    counters: () => counters,
    healLatched: () => latched,
    dispose: () => {
      disposed = true;
      if (cancelHeal) cancelHeal();
      cancelHeal = null;
    },
  };
}


// ── Dev console handle (never production) ──────────────────────────────────
// Attached as `window.__inboxDigest` by the hook, same convention as
// `__inboxStore`. Everything here is READ ONLY over the live store: `evaluate`
// is the pure compare with the tick's exact context (no heal, no telemetry),
// `replica` the working-set projection at the payload's epoch, `place` the
// chokepoint's sections as the panel asks for them, `renderVsStamp` the rows
// whose render-time placement disagrees with the server stamp (a clock or
// field gap, the class the 2026-09-01 "stopped" fact bug belonged to).
export type InboxDigestDevHandle = {
  evaluate: () => InboxCompareOutcome;
  replica: () => ReturnType<typeof projectReplicaInbox>;
  place: (focusedId?: string | null) => ReturnType<typeof placeInboxRows>;
  renderVsStamp: () => Array<Record<string, unknown>>;
  counters: InboxDigestComparer["counters"];
  healLatched: InboxDigestComparer["healLatched"];
  activity: () => { apply_age_ms: number; inflight: number };
  /** Logs each CHANGE of outcome (never every tick) so a device with no
   *  console handle still reports through its Metro output. */
  logOutcome: (outcome: InboxCompareOutcome) => void;
};

export function createInboxDigestDevHandle(
  comparer: InboxDigestComparer,
  crawlMetaKeyFor: InboxDigestComparerIO["crawlMetaKeyFor"],
): InboxDigestDevHandle {
  const evaluate = () => {
    const state = useInboxStore.getState();
    const meId = state.currentUser?._id?.toString?.() ?? null;
    return evaluateInboxCompare(state, {
      now: Date.now(),
      nowMono: monotonicNow(),
      crawlMetaKey: crawlMetaKeyFor(meId),
      lastApplyMono: lastSyncApplyMono(),
      inflight: syncInflightCount(),
    });
  };
  const replica = () => {
    const state = useInboxStore.getState();
    const slot = state.sessionsProjection?.mine;
    return projectReplicaInbox(state, { scope: "mine", focusedId: null, epoch: slot?.epoch ?? 0, now: slot?.epoch ?? Date.now() });
  };
  const place = (focusedId: string | null = null) => placeInboxRows(useInboxStore.getState(), { scope: "mine", focusedId, now: Date.now() });
  const renderVsStamp = () => {
    const state = useInboxStore.getState();
    const stamps = state.sessionsProjection?.mine?.stamps ?? {};
    const placed = place(null);
    const rep = replica();
    const deltas: Array<Record<string, unknown>> = [];
    for (const [id, stamp] of Object.entries(stamps)) {
      const p = placed.placements.get(id);
      if (!p || p.bucket === stamp.bucket) continue;
      const r: any = state.sessions[id] ?? {};
      const a: any = rep.adapted.get(id) ?? {};
      deltas.push({
        id: id.slice(0, 7), stamp: stamp.bucket, render: p.bucket, replica: rep.proj.placements.get(id)?.bucket ?? null,
        row: { agent_status: r.agent_status, is_idle: r.is_idle, awaiting: r.awaiting_input, thread: r.thread_state_status, verdict: r.settle_verdict, updated_at: r.updated_at, msgs: r.message_count, allows_park: r.last_turn_allows_park, dormant_at: r.inbox_dormant_at, is_dormant: r.is_dormant, armed: r.armed_trigger_kind, has_pending: r.has_pending_messages, api_err: r.pending_api_error },
        adapted: { agent_status: a.agent_status, is_idle: a.is_idle, verdict: a.settle_verdict, verdict_at: a.settle_verdict_at, dormant_at: a.inbox_dormant_at, has_pending: a.has_pending_messages },
      });
    }
    return deltas;
  };
  let lastLogged = "";
  const logOutcome = (outcome: InboxCompareOutcome) => {
    const line = `${outcome.kind}${"reason" in outcome && outcome.reason ? ":" + outcome.reason : ""}`;
    if (line === lastLogged) return;
    lastLogged = line;
    console.info(`[inboxDigest] ${line}`, "diff" in outcome && outcome.diff ? outcome.diff : "");
    const deltas = renderVsStamp();
    if (deltas.length) console.info("[inboxDigest] render_vs_stamp", JSON.stringify(deltas));
  };
  return {
    evaluate, replica, place, renderVsStamp,
    counters: comparer.counters,
    healLatched: comparer.healLatched,
    activity: () => ({ apply_age_ms: monotonicNow() - lastSyncApplyMono(), inflight: syncInflightCount() }),
    logOutcome,
  };
}
