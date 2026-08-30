// Decides what status a still-pending (optimistic) user message should surface
// beneath its bubble. Pulled out of ConversationView so the policy is unit-testable
// without rendering the monolith.
//
// The core insight: a message sitting "pending" is NOT proof it was lost. While the
// agent is mid-turn the daemon deliberately defers injection (ensureTmuxReady won't
// paste into a busy pane) and delivers the moment the turn ends — so "kill & restart"
// there would interrupt and discard live work. Only when the agent is genuinely idle
// (or gone) and STILL hasn't taken the message is a restart the right escalation.

import { MID_TURN_AGENT_STATUSES } from "@codecast/shared/contracts";

export type LiveAgentStatus =
  | "working"
  | "idle"
  | "permission_blocked"
  | "compacting"
  | "thinking"
  | "connected"
  | "starting"
  | "resuming"
  | "waiting"
  | "dormant"
  | "done";

// Agent states that prove the session is alive and processing — a message queued
// behind any of these will deliver when the turn ends. Mirrors MessageInput's
// isAgentActive so the per-message banner and the composer banner agree.
export const isActiveAgentStatus = (s?: LiveAgentStatus): boolean =>
  MID_TURN_AGENT_STATUSES.has(s ?? "");

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

// Settle verdicts from the daemon's classifier: the session's pane is alive and
// heartbeating, just parked between turns ("dormant" = a machine wakes it,
// "waiting" = open background tasks, "done" = declared delivered). A pending
// message to such a session is the ORDINARY case — the daemon injects it within
// seconds — so these must never be read as "idle/gone" and escalated on the
// short idle grace. They get the same calm "queued" treatment (and the same
// generous budget) as a booting session. This was the root of the false
// "Message hasn't reached the agent" alarms: a dormant-but-live session fell
// through to the idle branch, the web auto-fired a resume ~20s after send, and
// that resume interrupted the delivery already in flight.
export const isAliveIdleStatus = (s?: LiveAgentStatus): boolean =>
  s === "waiting" || s === "dormant" || s === "done";

export type PendingBannerState = "none" | "queued" | "stuck";

// - "queued": session still booting/resuming/connecting → brief "starting up"
//             reassurance (the agent has no input box yet). NOT used while the agent
//             is actively processing — that case shows nothing (see below).
// - "stuck":  agent idle/gone past a grace and still hasn't taken the message, or a
//             booting session still not processing past a generous boot budget, OR a
//             kill & restart is already in flight → show the restart bar.
// - "none":   the message already reached the session (durable delivery proof), is in a
//             live agent's input queue, or is still within a grace window → show nothing.
export function pendingBannerState(
  agentStatus: LiveAgentStatus | undefined,
  opts: { retryEligible: boolean; restartInFlight: boolean; idleGraceElapsed: boolean; bootGraceElapsed: boolean; messageReachedSession: boolean },
): PendingBannerState {
  if (opts.restartInFlight) return "stuck";
  if (!opts.retryEligible) return "none";
  // Durable, server-persisted proof the message physically landed in the session's pane
  // (pending_messages → "injected"/"delivered"; the daemon resets it to "pending" if the
  // session dies, so it's only set while a live session genuinely holds the message). This
  // is authoritative even when the live agent_status is UNKNOWN — a disconnected session, a
  // non-"active" conversation, or an older CLI that doesn't report agent_status all surface
  // as undefined, which would otherwise escalate straight to the alarming kill & restart.
  // Delivery proof trumps a missing heartbeat: never alarm about a message we know arrived.
  if (opts.messageReachedSession) return "none";
  // Agent alive and mid-turn: it has a live type-ahead input box, and the daemon has
  // already pasted the message straight into Claude Code's native queue (ensureTmuxReady's
  // busy path), so it WILL submit when the turn ends. Show nothing — the pending stripe on
  // the bubble already signals "not yet echoed", and nagging "queued — will send when the
  // agent finishes its turn" for a whole multi-minute turn is noise, not information.
  if (isActiveAgentStatus(agentStatus)) return "none";
  // A live-but-still-booting session reassures rather than alarms: the daemon injects
  // the pending message and flips to "working" once the pane is ready. Only a session
  // still not processing well past a generous boot budget is genuinely stuck.
  if (isBootingAgentStatus(agentStatus)) return opts.bootGraceElapsed ? "stuck" : "queued";
  // Alive-but-parked (dormant/waiting/done): the pane heartbeats, delivery is a
  // normal daemon pass away. Reassure, and only alarm past the boot budget.
  if (isAliveIdleStatus(agentStatus)) return opts.bootGraceElapsed ? "stuck" : "queued";
  return opts.idleGraceElapsed ? "stuck" : "none";
}

// Layered on top of pendingBannerState by the bubble. pendingBannerState judges
// the SESSION (booting, busy, idle, gone); this judges the DAEMON that carries
// the message. When the daemon is offline, quiet, freshly restarted, under load
// or behind on sync, a pending message is late because of the daemon — so say
// that, instead of "hasn't reached the agent" plus a kill & restart that would
// itself have to travel through the struggling daemon. A restart the user has
// already clicked keeps its progress UI: the daemon note must not paper over an
// action in flight.
export type PendingDeliveryState = PendingBannerState | "daemon";

export function withDaemonHealth(
  state: PendingBannerState,
  opts: { daemonDegraded: boolean; restartInFlight: boolean },
): PendingDeliveryState {
  if (state === "none" || opts.restartInFlight) return state;
  return opts.daemonDegraded ? "daemon" : state;
}
