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

// Agent states that mean the session is alive but hasn't begun this turn yet: it's
// launching ("starting"), reattaching after a resume ("resuming"), or up with the
// prompt visible and about to inject the pending message ("connected"). The daemon
// flips these to "working" once it pastes the message into the idle pane, so a
// message sitting behind them is NOT lost — a cold boot or resume just legitimately
// takes far longer than a turn. Distinct from "idle"/absent, which mean a turn
// already ended (or the session is gone) without taking the message — the genuine
// born-dead / dropped-delivery case that warrants a kill & restart.
export const isBootingAgentStatus = (s?: LiveAgentStatus): boolean =>
  s === "starting" || s === "resuming" || s === "connected";

export type PendingBannerState = "none" | "queued" | "stuck";

// - "queued": agent alive (processing, or booting/resuming) → reassure, no restart.
// - "stuck":  agent idle/gone past a grace and still hasn't taken the message, or a
//             booting session still not processing past a generous boot budget, OR a
//             kill & restart is already in flight → show the restart bar.
// - "none":   still within a grace window → show nothing.
export function pendingBannerState(
  agentStatus: LiveAgentStatus | undefined,
  opts: { retryEligible: boolean; restartInFlight: boolean; idleGraceElapsed: boolean; bootGraceElapsed: boolean },
): PendingBannerState {
  if (opts.restartInFlight) return "stuck";
  if (!opts.retryEligible) return "none";
  if (isActiveAgentStatus(agentStatus)) return "queued";
  // A live-but-still-booting session reassures rather than alarms: the daemon injects
  // the pending message and flips to "working" once the pane is ready. Only a session
  // still not processing well past a generous boot budget is genuinely stuck.
  if (isBootingAgentStatus(agentStatus)) return opts.bootGraceElapsed ? "stuck" : "queued";
  return opts.idleGraceElapsed ? "stuck" : "none";
}
