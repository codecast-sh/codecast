// Decides what status a still-pending (optimistic) user message should surface
// beneath its bubble. Pulled out of ConversationView so the policy is unit-testable
// without rendering the monolith.
//
// The core insight: a message sitting "pending" is NOT proof it was lost. While the
// agent is mid-turn the daemon deliberately defers injection (ensureTmuxReady won't
// paste into a busy pane) and delivers the moment the turn ends — so "kill & restart"
// there would interrupt and discard live work. Only when the agent is genuinely idle
// (or gone) and STILL hasn't taken the message is a restart the right escalation.

export type LiveAgentStatus =
  | "working"
  | "idle"
  | "permission_blocked"
  | "compacting"
  | "thinking"
  | "connected"
  | "starting"
  | "resuming";

// Agent states that prove the session is alive and processing — a message queued
// behind any of these will deliver when the turn ends. Mirrors MessageInput's
// isAgentActive so the per-message banner and the composer banner agree.
export const isActiveAgentStatus = (s?: LiveAgentStatus): boolean =>
  s === "working" || s === "thinking" || s === "compacting" || s === "permission_blocked";

export type PendingBannerState = "none" | "queued" | "stuck";

// - "queued": agent alive and processing → reassure, never offer a restart.
// - "stuck":  agent idle/gone past a grace and still hasn't taken the message,
//             OR a kill & restart is already in flight → show the restart bar.
// - "none":   still within a grace window → show nothing.
export function pendingBannerState(
  agentStatus: LiveAgentStatus | undefined,
  opts: { retryEligible: boolean; restartInFlight: boolean; idleGraceElapsed: boolean },
): PendingBannerState {
  if (opts.restartInFlight) return "stuck";
  if (!opts.retryEligible) return "none";
  if (isActiveAgentStatus(agentStatus)) return "queued";
  return opts.idleGraceElapsed ? "stuck" : "none";
}
