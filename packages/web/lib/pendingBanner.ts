// Decides what status a still-pending (optimistic) user message should surface
// beneath its bubble. Pulled out of ConversationView so the policy is unit-testable
// without rendering the monolith.
//
// The core insight: a message sitting "pending" is NOT proof it was lost. While the
// agent is mid-turn the daemon deliberately defers injection (ensureTmuxReady won't
// paste into a busy pane) and delivers the moment the turn ends — so "kill & restart"
// there would interrupt and discard live work. Only when the agent is genuinely idle
// (or gone) and STILL hasn't taken the message is a restart the right escalation.

import { MID_TURN_AGENT_STATUSES, isRecoveryContinueClientId } from "@codecast/shared/contracts";

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

export function sessionMessageQueueLabel(status?: string, reason?: string, recipientStatus?: string): string | null {
  if (!status) return null;
  if (reason) return `queued · ${reason}`;
  if (status === "failed" || status === "undeliverable") return "queued · retrying";
  if (recipientStatus === "permission_blocked") return "queued · waiting for an answer";
  if (recipientStatus === "stopped") return "queued · recipient offline";
  if (status === "injected") return "queued · awaiting confirmation";
  if (MID_TURN_AGENT_STATUSES.has(recipientStatus ?? "")) return "queued · recipient busy";
  return "queued · awaiting delivery";
}

export function pendingMessageCanRetry(content: string): boolean {
  return !/^(?:\[Request (?:interrupted|cancelled)|<turn_aborted>)/.test(content.trimStart());
}

export function pendingRetryClientId(messageId: string): string | undefined {
  return messageId.startsWith("serverpending_") ? undefined : messageId;
}

export type ServerPendingRow = { message_id: string; client_id?: string; created_at: number; status: string; content: string; hold_reason?: string; queued?: boolean; from_user_id?: string };
// getConversationPendingMessage: the primary row (oldest in flight, else the
// newest settled) plus `inflight`, every undelivered row. Older servers send
// no `inflight`.
export type ServerPendingStatus = ServerPendingRow & { inflight?: ServerPendingRow[] };

// Every server row that may need a bubble: all undelivered rows, or the
// settled primary when nothing is in flight.
export function serverPendingRows(pending?: ServerPendingStatus | null): ServerPendingRow[] {
  if (!pending) return [];
  return pending.inflight?.length ? pending.inflight : [pending];
}

/** The messages a session holds that have not reached it, from its server pending rows (whichever window sent them), oldest first. */
function heldSends(pending: ServerPendingStatus | null | undefined): ServerPendingRow[] {
  return serverPendingRows(pending).filter((r) => r.status === "pending" && !!r.content);
}

/** A conversation's held sends, read from the store's server pending rows (a selector). */
export function heldSendsOf(s: { pendingMessageStatus?: Record<string, unknown> }, conversationId: string | undefined): ServerPendingRow[] {
  return conversationId ? heldSends(s.pendingMessageStatus?.[conversationId] as ServerPendingStatus | undefined) : [];
}

type PendingRowRef = { message_id: string; client_id?: string; status?: string; hold_reason?: string };
type PendingLookup = PendingRowRef & { inflight?: PendingRowRef[] };

// The server row behind a bubble: `serverpending_<id>` or the sender's client id.
export function serverPendingRowFor<T extends PendingRowRef>(messageId: string, pending?: (T & { inflight?: T[] }) | null): T | undefined {
  return [pending, ...(pending?.inflight ?? [])].find((row): row is T & { inflight?: T[] } =>
    !!row && (messageId === `serverpending_${row.message_id}` || messageId === row.client_id || messageId === row.message_id));
}

// Identity the cancel dispatch can look the row up with. A local optimistic
// bubble is keyed by its client id; a bubble synthesized from the conversation's
// pending_messages row uses the `serverpending_` prefix. When the conversation
// pending row matches this bubble, pass both so the server can find it either way.
export function pendingCancelRef(
  messageId: string,
  pending?: PendingLookup | null,
): { messageId?: string; clientId?: string } {
  if (messageId.startsWith("serverpending_")) {
    return { messageId: messageId.slice("serverpending_".length) };
  }
  const row = serverPendingRowFor(messageId, pending);
  if (row) return { messageId: row.message_id, clientId: row.client_id };
  return { clientId: messageId };
}

// Whether the conversation's server pending row still needs its own bubble
// (the caller has already ruled out text that is on screen). In flight:
// always. Delivered: only while this window's transcript has not reached the
// row's send time, and only at the live tail; past that point its echo is
// either rendering already or never coming. Cancelled: never.
export function serverPendingBubbleVisible(
  pending: { status: string; created_at: number },
  window: { newestServerTs: number; atLiveTail: boolean },
): boolean {
  if (pending.status === "cancelled") return false;
  if (pending.status !== "delivered") return true;
  return window.atLiveTail && window.newestServerTs < pending.created_at;
}

// The bubbles the timeline adds for server pending rows: every queued message,
// whichever device or CLI sent it, for every viewer. A row already on screen
// (a synced message or a local optimistic copy, by client id or by content)
// adds nothing, but two queued rows with the same text are two sends and both
// render; the real JSONL echo fills `seenContent` with the same
// normalized key, which is what drops the bubble. A delivered row renders as a
// plain message while serverPendingBubbleVisible says its echo is still coming.
export function serverPendingBubbles(
  pending: ServerPendingStatus | null | undefined,
  timeline: {
    seen: Set<string>;
    seenContent: Set<string>;
    local: Array<{ _id: string; _clientId?: string }>;
    newestServerTs: number;
    atLiveTail: boolean;
    normalize: (content: string) => string;
  },
) {
  const bubbles = [];
  for (const row of serverPendingRows(pending)) {
    // Queued for the end of the turn: it shows in the shared queue above the
    // composer, and becomes a bubble when the turn ends and it goes in.
    if (row.status === "held") continue;
    if (!serverPendingBubbleVisible(row, timeline)) continue;
    const id = row.client_id;
    if (id && (timeline.seen.has(id) || timeline.local.some((m) => m._id === id || m._clientId === id))) continue;
    const norm = timeline.normalize(row.content);
    if (!norm || timeline.seenContent.has(norm)) continue;
    bubbles.push({
      _id: `serverpending_${row.message_id}`,
      role: "user" as const,
      content: row.content,
      timestamp: row.created_at,
      // Whoever sent it, so a teammate's queued message is not drawn as the viewer's.
      ...(row.from_user_id ? { from_user_id: row.from_user_id } : {}),
      ...(row.status === "delivered" ? {} : { _isOptimistic: true }),
      _serverPendingStatus: row.status,
      _serverPendingReason: row.hold_reason,
      _recoveryContinue: isRecoveryContinueClientId(row.client_id),
    });
  }
  return bubbles;
}

// The conversation's pending row as the composer's delivery tracker sees it.
// getConversationPendingMessage falls back to the newest SETTLED row
// (delivered/cancelled) so a lagging transcript keeps its bubble; to the
// tracker that row is nothing in flight. Reading it as in flight raised
// "Disconnected · Cancel" (and an auto-resume) after every delivered message.
export function inFlightPending<T extends { status?: string }>(pending: T | null | undefined): T | null {
  // No status: a viewer with only others' queued rows (no primary of their
  // own). Held: waiting on purpose (the end of a turn), nothing to deliver yet.
  if (!pending || !pending.status || pending.status === "delivered" || pending.status === "cancelled" || pending.status === "held") return null;
  return pending;
}

/** Why the daemon is holding this message back, when it said (retryMessage holdReason): a key to add, a dialog to answer. */
export function pendingMessageHoldReason(messageId: string, pending?: PendingLookup | null): string | undefined {
  return pendingRowHoldReason(serverPendingRowFor(messageId, pending));
}

/** A pending row's hold reason: set while the daemon holds it back on purpose, rather than working on it. */
export function pendingRowHoldReason(row: { status?: string; hold_reason?: string | null } | null | undefined): string | undefined {
  return row?.status === "pending" && row.hold_reason ? row.hold_reason : undefined;
}

export function pendingMessageReachedSession(messageId: string, pending?: PendingLookup | null): boolean {
  const row = serverPendingRowFor(messageId, pending);
  return !!row && (row.status === "injected" || row.status === "delivered");
}

// - "queued": the session is booting/resuming/connecting, parked, or idle and simply
//             hasn't taken the message yet → calm reassurance. NOT used while the agent
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
  // Durable, server-persisted proof the message physically landed in the session's pane
  // (pending_messages → "injected"/"delivered"; the daemon resets it to "pending" if the
  // session dies, so it's only set while a live session genuinely holds the message). This
  // is authoritative even when the live agent_status is UNKNOWN — a disconnected session, a
  // non-"active" conversation, or an older CLI that doesn't report agent_status all surface
  // as undefined, which would otherwise escalate straight to the alarming kill & restart.
  // Delivery proof trumps a missing heartbeat: never alarm about a message we know arrived.
  if (opts.messageReachedSession) return "none";
  if (opts.restartInFlight) return "stuck";
  if (!opts.retryEligible) return "none";
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
  // Idle, or no live status at all (disconnected session, non-"active" conversation,
  // older CLI). This is the only branch with real evidence of a problem, but the
  // evidence is weak — an idle pane is also the ordinary state a message is delivered
  // into. So it reassures first, exactly like the booting and parked branches, and
  // alarms only once the grace has passed with the message still unclaimed.
  return opts.idleGraceElapsed ? "stuck" : "queued";
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
