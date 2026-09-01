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
  INBOX_WINDOW_CAPS,
  inWorkingSet,
  type InboxTruncation,
  type WorkingSetWindow,
} from "@codecast/shared/contracts";
import {
  anyOverlayActive,
  collectInboxOverlayDeps,
  isOverlayAffected,
  type InboxOverlayState,
} from "./inboxOverlays";
import {
  monotonicNow,
  projectReplicaInbox,
  sessionsWithPendingSend,
  type PlaceInboxState,
  type SessionsProjectionSlot,
} from "./inboxStore";
import { lastSyncApplyMono, syncInflightCount } from "./syncActivity";

// ── Constants (the pinned contract) ─────────────────────────────────────────

/** The coarse tick the compare runs on. */
export const INBOX_COMPARE_TICK_MS = 15_000;
/** A payload older than this (receipt clock) is skipped: stale_payload. */
export const INBOX_COMPARE_MAX_PAYLOAD_AGE_MS = 90_000;
/** Past this age a quiet scope gets ONE budgeted overlay probe (C2). */
export const INBOX_PROBE_PAYLOAD_AGE_MS = 300_000;
/** The stale-payload probe's slow budget: at most one per this window. */
export const INBOX_PROBE_MIN_INTERVAL_MS = 300_000;
/** Quiescence: no row apply for this many coarse ticks, nothing in flight. */
export const INBOX_COMPARE_QUIESCENT_TICKS = 2;
export const INBOX_COMPARE_QUIESCENT_MS = INBOX_COMPARE_QUIESCENT_TICKS * INBOX_COMPARE_TICK_MS;
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

export type InboxCompareOutcome =
  /** Kill switch (C8): the payload carries no digest. Compare AND heal off. */
  | { kind: "disabled" }
  | { kind: "skip"; reason: InboxCompareSkip; payload_v?: number; payload_age_ms?: number }
  | { kind: "clean"; epoch: number; short_circuit: boolean; payload_age_ms: number }
  | { kind: "diff"; epoch: number; diff: InboxDriftDiff; payload_age_ms: number; set_digest: string };

export type InboxCompareContext = {
  /** Wall clock: overlay bounds and trust decay (the server applied the same TTLs). */
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

const WINDOW_KINDS: ReadonlySet<string> = new Set(Object.keys(INBOX_WINDOW_CAPS));
function isWindowKind(t: InboxTruncation): t is WorkingSetWindow {
  return WINDOW_KINDS.has(t);
}

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

  // The procedure. The replica's projection at the payload's epoch.
  const focusedId = state.currentSessionId ?? null;
  const { proj, rowById, adapted } = projectReplicaInbox(state, { scope: "mine", focusedId, epoch: slot.epoch, now: ctx.now });
  const pendingSendIds = new Set<string>([...state.sessionsWithQueuedMessages, ...sessionsWithPendingSend(state.pendingMessages)]);
  const deps = collectInboxOverlayDeps(
    {
      sessions: state.sessions,
      pending: state.pending,
      pendingSessionCreates: state.pendingSessionCreates ?? {},
      currentSessionId: focusedId,
      sessionsWithQueuedMessages: state.sessionsWithQueuedMessages,
      blockedReviveRequestedAt: state.blockedReviveRequestedAt ?? {},
    },
    ctx.now,
    { pendingSendIds },
  );
  if (!anyOverlayActive(deps) && proj.set_digest === slot.set_digest) {
    return { kind: "clean", epoch: slot.epoch, short_circuit: true, payload_age_ms };
  }

  // Per-row diff with the carve-outs.
  const truncatedWindows = new Set<WorkingSetWindow>();
  for (const t of slot.truncated) if (isWindowKind(t)) truncatedWindows.add(t);
  for (const t of proj.truncated) if (isWindowKind(t)) truncatedWindows.add(t);
  const foreignScan = slot.truncated.includes("foreign_scan");
  const meId = state.currentUser?._id?.toString?.() ?? null;
  const dropped = (id: string): boolean => {
    if (isOverlayAffected(id, deps)) return true;
    if (truncatedWindows.size > 0) {
      // Eligibility windows, not just the selected ones: a held row the cap
      // cut on one side only is exactly the overflow case the flag names.
      const row = adapted.get(id);
      const windows = row ? inWorkingSet(row, slot.epoch) : proj.windows.get(id);
      if (windows && windows.length > 0 && windows.every((w) => truncatedWindows.has(w))) return true;
    }
    if (foreignScan && meId) {
      const row = rowById.get(id);
      if (row?.user_id && row.user_id !== meId) return true;
    }
    return false;
  };
  const diff: InboxDriftDiff = { missing: [], extra: [], bucket_deltas: [], fold_deltas: [] };
  const stamps = slot.stamps;
  for (const id in stamps) {
    if (dropped(id)) continue;
    const local = proj.placements.get(id);
    if (!local) {
      diff.missing.push(id);
      continue;
    }
    const stamp = stamps[id];
    if (local.bucket !== stamp.bucket) diff.bucket_deltas.push(id);
    else if (local.below_fold !== stamp.below_fold) diff.fold_deltas.push(id);
  }
  for (const id of proj.placements.keys()) {
    if (id in stamps || dropped(id)) continue;
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
  /** Heals that had to hydrate missing bodies (getInboxSessionsByIds) — counted separately. */
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
  // Persistence rule (C6): a diff counts only when it persists across two
  // consecutive compares at DISTINCT payload epochs.
  let pendingDiffEpoch: number | null = null;
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
    const missing = diff.missing.slice();
    cancelHeal = schedule(() => {
      cancelHeal = null;
      (async () => {
        try {
          // Missing bodies first: their facts arrive with the probe's overlay,
          // which now has rows to land on. Bucket/fold deltas on held rows are
          // stale facts, and facts have one writer — the probe alone heals them.
          if (missing.length) {
            await io.fetchByIds(missing);
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
        pendingDiffEpoch = null;
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
        pendingDiffEpoch = null;
        break;
      case "diff":
        counters.checks++;
        counters.max_payload_age_ms = Math.max(counters.max_payload_age_ms, outcome.payload_age_ms);
        if (pendingDiffEpoch !== null && pendingDiffEpoch !== outcome.epoch) {
          // Persisted across two compares at distinct payload epochs: drift.
          pendingDiffEpoch = null;
          onConfirmedDrift(outcome, t);
        } else if (pendingDiffEpoch === null) {
          pendingDiffEpoch = outcome.epoch;
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
