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
