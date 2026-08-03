// Single source of truth for the daemon-reported agent status of a managed
// session. Defined ONCE here and consumed by all three runtimes:
//   - the Convex backend (managedSessions.ts agentStatusValidator, schema.ts) —
//     derives v.union(...AGENT_STATUSES.map(v.literal)) so the validator accepts
//     exactly this set;
//   - the Node daemon (cli/src/daemon.ts) — imports the AgentStatus type;
//   - the browser store (web/store/inboxStore.ts).
//
// The set must stay byte-identical with managedSessions.ts. Historically the CLI
// kept its own union and drifted (it was missing "starting"), so a CLI-first
// status addition would have thrown on every heartbeatBatch validation and
// marked live sessions dead fleet-wide. Adding a status now means editing this
// one array.
//
// PURE isomorphic data — no Node or DOM APIs — so the Convex runtime (which
// forbids them outside "use node" modules) can import it.
export const AGENT_STATUSES = [
  "working",
  "idle",
  "permission_blocked",
  "compacting",
  "thinking",
  "connected",
  "stopped",
  "starting",
  "resuming",
  // Turn ended but the harness holds live background work (a run_in_background
  // command, a Monitor) that will re-invoke the agent when it finishes. The ball
  // is NOT in the user's court, so this is an active substate, not idle. The
  // daemon derives it from the transcript (open task starts minus terminal
  // task-notifications); it decays through the normal STATUS_TRUST_TTL_MS path,
  // so a task that never exits (e.g. a dev server) cannot pin a session in the
  // working bucket forever.
  "waiting",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

// The canonical "agent is actively producing" set. A session in one of these is
// busy and should NOT be classified idle/needs-input. This reconciles three
// previously-separate copies:
//   - web/store/inboxStore.ts ACTIVE_AGENT_STATUSES
//   - convex/inboxFilters.ts ACTIVE_AGENT_STATUSES
// which were already identical. "idle", "permission_blocked" and "stopped" are
// deliberately excluded (finished / blocked on the user / dead).
//
// NOTE on the deliberate CLI difference: cli/src/resourceMonitor.ts
// WORKING_STATUSES omits "connected". That set gates CPU-idle accounting and the
// metrics report, where "connected" (transport/MCP up but not yet producing
// tokens) should count as idle, not working. It is a behavioral gate, not a
// status contract, so it intentionally diverges from this canonical set.
//
// Typed as ReadonlySet<string> (not <AgentStatus>) so callers can probe it with
// a raw, possibly-stale daemon string — `set.has(agent_status)` — without a cast
// at every site.
export const ACTIVE_AGENT_STATUSES: ReadonlySet<string> = new Set<string>([
  "working",
  "compacting",
  "thinking",
  "connected",
  "starting",
  "resuming",
  "waiting",
]);

// How long a daemon-reported ACTIVE status is trusted with no fresh activity on
// the conversation. A daemon that finished re-asserts its last "working" on
// every heartbeat; if the conversation has synced nothing for this long the
// status is stale and must read as finished, not working. Keyed on the
// conversation's updated_at — the one field that stays accurate even when a
// row's live status is frozen (e.g. a session that aged out of the liveness
// overlay's window keeps its last status forever). One hour is ~30x the p99
// real tool-execution time (~2 min), so a genuinely working agent — which emits
// tool calls far more often — never goes this quiet. Consumed in two places that
// must agree: the backend coercion (convex/inboxFilters.ts trustedAgentStatus,
// the authority for in-window rows) and the web client's bucketing safety net
// (web/store/inboxStore.ts, which catches aged-out rows the overlay can't refresh).
export const STATUS_TRUST_TTL_MS = 60 * 60 * 1000;

// Pure staleness predicate over a conversation row: its last activity is older
// than the trust TTL, so any active live status it still carries (agent_status,
// is_idle:false) can no longer be believed. This is THE shared test every reader
// of a row's live status must apply, so the inbox bucket and the UI "working"
// dot can never disagree about whether a frozen-"working" row is actually
// working. message_count>0 gates out blank rows (no work to mistrust). Keyed on
// updated_at — the one field that stays accurate when live status is frozen.
// Callers layer their own policy on top (the inbox bucket also exempts pinned,
// which lives in its own group regardless of staleness).
export function isStatusTrustStale(
  s: { message_count?: number; updated_at?: number },
  now: number,
): boolean {
  return (s.message_count ?? 0) > 0 && now - (s.updated_at || 0) >= STATUS_TRUST_TTL_MS;
}

// Anti-flicker grace before a finished agent is treated as idle. Shared by the
// backend's isSessionIdle recency gate (convex/inboxFilters.ts re-exports it)
// and the client's statusless-row sweep below, so both sides settle a quiet
// session on the same clock.
export const AGENT_IDLE_GRACE_MS = 45 * 1000;

// Companion to isStatusTrustStale for rows with NO claim of active work. The
// long TTL above gives a present ACTIVE agent_status an hour of benefit of the
// doubt; a row carrying no active status deserves none — nothing anywhere says
// it is working, its "working" appearance is only the bucket fallthrough over a
// null/frozen is_idle. Such a row (no active agent_status, is_idle not true, no
// server-queued message) that has been quiet past the idle grace is settled —
// the client mirror of the server's no-status branch of isSessionIdle. This is
// how rows the sessionsLiveness overlay never covers (killed rows, subagent
// rows, unmanaged imports — see shouldShowInInbox) escape the WORKING bucket:
// their liveness fields freeze at the last synced value, but updated_at stays
// honestly quiet.
export function isQuietSettled(
  s: {
    agent_status?: string | null;
    is_idle?: boolean | null;
    has_pending?: boolean | null;
    message_count?: number;
    updated_at?: number;
  },
  now: number,
): boolean {
  if (s.agent_status && ACTIVE_AGENT_STATUSES.has(s.agent_status)) return false;
  if (s.is_idle === true) return false; // already settled the normal way
  if (s.has_pending) return false; // server-queued work in flight
  return (s.message_count ?? 0) > 0 && now - (s.updated_at || 0) >= AGENT_IDLE_GRACE_MS;
}

// THE staleness test every reader of a row's live-looking fields (agent_status,
// is_idle:false) must apply — the inbox bucket, the pulsing dot, the status
// pill. One predicate so they can never disagree (a needs-input card with a
// green "working" dot is the historical failure mode). True when the row's
// liveness can no longer be believed: an active status gone quiet past the 1h
// trust TTL, or a statusless row quiet past the 45s idle grace.
export function isLivenessStale(
  s: {
    agent_status?: string | null;
    is_idle?: boolean | null;
    has_pending?: boolean | null;
    message_count?: number;
    updated_at?: number;
  },
  now: number,
): boolean {
  return isStatusTrustStale(s, now) || isQuietSettled(s, now);
}
