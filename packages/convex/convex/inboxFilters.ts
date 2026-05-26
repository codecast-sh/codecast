import type { Doc } from "./_generated/dataModel";

export type ConversationDoc = Doc<"conversations">;

export const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"] as const;

export function isNoiseTitle(title: string | undefined): boolean {
  const t = title?.trim() || "";
  if (!t) return false;
  if (t.toLowerCase() === "warmup") return true;
  return NOISE_TITLE_PREFIXES.some((p) => t.startsWith(p));
}

export function isOrphanOrSubagent(conv: ConversationDoc): boolean {
  if (conv.is_subagent === true) return true;
  if (conv.is_workflow_sub === true) return true;
  if (conv.parent_conversation_id && !conv.parent_message_uuid) return true;
  return false;
}

// `inbox_dismissed_at` is an absolute flag: a truthy value means dismissed until
// a user action clears it. Never compare it against `updated_at`. See
// schema.ts for the list of mutations allowed to clear it.
//
// Dismissed conversations are still part of the inbox — clients categorize them
// into a separate bucket via the `inbox_dismissed_at` field on each result.
export function shouldShowInInbox(conv: ConversationDoc): boolean {
  if (isOrphanOrSubagent(conv)) return false;
  if (conv.status === "completed" && conv.message_count === 0) return false;
  if (isNoiseTitle(conv.title)) return false;
  if (conv.inbox_killed_at) return false;
  return true;
}

// Anti-flicker grace before a finished agent is treated as idle. Mirrors the
// "working" pill in ConversationView so the inbox bucket and the per-conversation
// header agree for the moment right after a turn ends.
export const AGENT_IDLE_GRACE_MS = 45 * 1000;

const ACTIVE_AGENT_STATUSES = new Set([
  "working",
  "compacting",
  "thinking",
  "connected",
  "starting",
  "resuming",
]);

export interface SessionIdleInput {
  /** managed_sessions.agent_status, coerced for heartbeat staleness by the caller. */
  agentStatus?: string;
  /** managed_sessions.agent_status_updated_at — when the daemon last *changed* the status. */
  agentStatusUpdatedAt?: number;
  hasPending: boolean;
  /** Last message (by sync order) is a non-interrupt user turn. */
  lastRoleIsUser: boolean;
  /** (now - conv.updated_at) < AGENT_IDLE_GRACE_MS. */
  recentlyUpdated: boolean;
  daemonAlive: boolean;
  now: number;
}

// Whether a top-level session is idle (agent finished its turn, ball in the
// user's court). The subtle part is the grace window that avoids flickering to
// "needs input" the instant an assistant turn ends.
//
// When the daemon reports a definite status, the grace is measured from
// `agentStatusUpdatedAt` (the moment the Stop hook flipped the agent to
// idle/stopped) — NOT from `conv.updated_at`. The conversation's updated_at is
// bumped by every synced message, so a large message backlog draining in after
// a turn ends keeps `recentlyUpdated` true for minutes and would otherwise pin a
// finished agent in "working" long past the grace. Once the status has settled
// past the grace, the agent is genuinely waiting on the user, so we ignore both
// the updated_at churn and a lagging last_message_role (the final assistant turn
// may not have synced yet). When the status timestamp is absent (legacy
// sessions), fall back to the conv.updated_at recency gate.
export function isSessionIdle(input: SessionIdleInput): boolean {
  const {
    agentStatus,
    agentStatusUpdatedAt,
    hasPending,
    lastRoleIsUser,
    recentlyUpdated,
    daemonAlive,
    now,
  } = input;

  if (agentStatus) {
    if (ACTIVE_AGENT_STATUSES.has(agentStatus)) return false;
    if (hasPending) return false; // queued work — agent isn't waiting on the user
    const settled =
      agentStatusUpdatedAt !== undefined &&
      now - agentStatusUpdatedAt >= AGENT_IDLE_GRACE_MS;
    if (settled) return true;
    // Within the grace (or no status timestamp): stay conservative.
    return !lastRoleIsUser && !recentlyUpdated;
  }

  // No daemon status: fall back to liveness + recency heuristics.
  return daemonAlive
    ? !hasPending && !lastRoleIsUser && !recentlyUpdated
    : !recentlyUpdated;
}
