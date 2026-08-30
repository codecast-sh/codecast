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
  // The three SETTLE VERDICTS below are siblings of "idle": the turn is over,
  // and the status says why the agent stopped. The daemon re-derives the
  // verdict at every turn end, so a verdict never outlives the settle that
  // produced it — a wake (trigger inject, Monitor completion, a human message)
  // flips the agent to "working" and the next settle must earn its verdict
  // again. None of them is "active": the agent is not producing.
  //
  // Turn ended but the harness holds live background work (a run_in_background
  // command, a Monitor, a workflow) that will re-invoke the agent when it
  // finishes. Inferred from the transcript (open task starts minus terminal
  // task-notifications), so it keeps the STATUS_TRUST_TTL_MS decay: a task that
  // never exits (a dev server) cannot park a session forever.
  "waiting",
  // Turn ended and the agent DECLARED it is parked on a nameable machine wake
  // (`cast state --status dormant`). Exempt from the quiet-time decay — a
  // nightly trigger's home is quiet for 23h by design — but a dead daemon still
  // coerces it away, since a dead daemon cannot deliver the promised wake.
  "dormant",
  // Turn ended and the agent DECLARED the task delivered (`cast state --status
  // done`). Nothing is stalled; the human reads it at leisure.
  "done",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

// The settle verdicts: turn over, agent quiet, and the status names why. Every
// "is this session settled" predicate treats these exactly like "idle"; only
// the work-state classifier tells them apart.
export const SETTLE_VERDICT_STATUSES: ReadonlySet<string> = new Set<string>([
  "waiting",
  "dormant",
  "done",
]);

// The declared subset — an agent said so, on purpose, this turn. Trusted past
// the quiet-time decay because the declaration names the wake / the delivery.
export const DECLARED_VERDICT_STATUSES: ReadonlySet<string> = new Set<string>([
  "dormant",
  "done",
]);

// The canonical "agent is actively producing" set. A session in one of these is
// busy and should NOT be classified idle/needs-input. This reconciles three
// previously-separate copies:
//   - web/store/inboxStore.ts ACTIVE_AGENT_STATUSES
//   - convex/inboxFilters.ts ACTIVE_AGENT_STATUSES
// which were already identical. "idle", "permission_blocked" and "stopped" are
// deliberately excluded (finished / blocked on the user / dead), and so are the
// SETTLE_VERDICT_STATUSES: a parked or delivered agent is not producing, and
// putting "waiting" here used to file every Monitor-parked session under
// WORKING and count it in the "N agents running" badge.
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
]);

// A turn is in progress: the agent is producing, or stopped inside the turn on a
// permission prompt. This is the set an interrupt (web Escape -> daemon "escape"
// -> double Escape / SIGINT) has something to cancel. Narrower than
// ACTIVE_AGENT_STATUSES on purpose: "connected" / "starting" / "resuming" are a
// session coming up with no turn yet, and a SIGINT that reaches claude at its
// prompt EXITS the process instead of interrupting anything (2026-08-28).
// Consumed by web/lib/pendingBanner.ts (composer + per-message banner) and the
// daemon's escape handler so the two agree on "there is a turn to interrupt".
export const MID_TURN_AGENT_STATUSES: ReadonlySet<string> = new Set<string>([
  "working",
  "thinking",
  "compacting",
  "permission_blocked",
]);

// Statuses the quiet-time trust decay (STATUS_TRUST_TTL_MS) applies to: every
// ACTIVE status, plus the INFERRED settle verdict. "waiting" is scraped from
// the transcript, so a background task that never emits a terminal notification
// (a dev server, a wedged watch) would otherwise park its session forever; an
// hour of silence demotes it to plain "idle" and the row resurfaces. The
// declared verdicts are deliberately absent — see DECLARED_VERDICT_STATUSES.
export const TRUST_DECAYING_STATUSES: ReadonlySet<string> = new Set<string>([
  ...ACTIVE_AGENT_STATUSES,
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
//
// Killed rows stay on that list, and the two arms divide by whether the client
// ever RECEIVES the marker. shouldShowInInbox drops `inbox_killed_at &&
// !inbox_pinned_at` from every query that projects the field, so an UNPINNED
// killed row never arrives carrying it — the client holds a stale pre-kill copy
// and these time-based arms remain its only compensation (see the overlay note
// in convex/conversations.ts). A PINNED killed row does arrive with the marker,
// and isLivenessStale short-circuits on it there — which this branch could not
// do anyway: it returns early on any ACTIVE agent_status, and kill never
// touches updated_at, so a session killed mid-turn would wait out the full
// trust TTL here.
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
// liveness can no longer be believed: the row was RETIRED, an active status has
// gone quiet past the 1h trust TTL, or a statusless row is quiet past the 45s
// idle grace.
//
// inbox_killed_at is checked first and needs no clock at all: the agent was torn
// down, so whatever live-looking fields the row still carries are by definition
// no longer believable. Neither time-based arm catches the common case on its
// own — killing a session that was mid-turn leaves an ACTIVE agent_status
// (isQuietSettled bails immediately) and kill never touches updated_at
// (isStatusTrustStale needs a full hour) — so a torn-down session went on
// pulsing green for up to an hour.
export function isLivenessStale(
  s: {
    agent_status?: string | null;
    is_idle?: boolean | null;
    has_pending?: boolean | null;
    message_count?: number;
    updated_at?: number;
    inbox_killed_at?: number | null;
  },
  now: number,
): boolean {
  if (s.inbox_killed_at) return true;
  return isStatusTrustStale(s, now) || isQuietSettled(s, now);
}
