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
  if (conv.inbox_killed_at && !conv.inbox_pinned_at) return false;
  return true;
}

// Whether `parent` is a conversation an orchestration worker can safely be
// nested under at spawn time. We only stamp a worker's parent_conversation_id
// when this holds, because listInboxSessions surfaces a child *only* under a
// parent that is itself in the inbox and not dismissed (see the `dismissed`
// guard in that query). Linking to a parent that fails this test would make
// the worker vanish entirely instead of nesting. When it returns false the
// caller leaves the worker top-level and the client's plan-grouping fallback
// takes over.
export function isViableInboxParent(
  parent: ConversationDoc | null | undefined,
  userId: string,
): boolean {
  if (!parent) return false;
  if (parent.user_id.toString() !== userId) return false;
  if (parent.inbox_dismissed_at) return false;
  return shouldShowInInbox(parent);
}

// Anti-flicker grace before a finished agent is treated as idle. Mirrors the
// "working" pill in ConversationView so the inbox bucket and the per-conversation
// header agree for the moment right after a turn ends.
export const AGENT_IDLE_GRACE_MS = 45 * 1000;

export const ACTIVE_AGENT_STATUSES = new Set([
  "working",
  "compacting",
  "thinking",
  "connected",
  "starting",
  "resuming",
]);

// A daemon-reported status that means the agent process is gone. A dead session
// with content still needs a human (to read the result / restart it), so the
// classifier routes it to needs-input rather than working. Mirrors the web
// store's DEAD_AGENT_STATUSES.
export const DEAD_AGENT_STATUSES = new Set(["stopped"]);

// Decides whether a batch of freshly-synced messages should bump
// managed_sessions.agent_status back to "working". Two cases, both meaning the
// agent is actively producing again:
//   - an assistant turn arrives while the session was parked idle by the grace
//   - a user message carrying tool_results arrives while the session is
//     permission_blocked — the agent received its input back (an AskUserQuestion
//     answer, or a permissioned tool that just completed). The "working"
//     PreToolUse hook that normally clears permission_blocked is fire-and-forget
//     and can be lost under load, latching the session in "Needs Input" forever
//     even though the transcript shows it resumed; this is the durable,
//     hook-independent clear. Gated on tool_results so a free-form user chat
//     can't clear a genuinely pending prompt (those messages carry none).
// Returns the next status, or null to leave it unchanged.
export function nextAgentStatusOnAddMessages(
  currentStatus: string | undefined,
  hasAssistantMsg: boolean,
  hasToolResultReply: boolean,
): "working" | null {
  if (hasAssistantMsg && currentStatus === "idle") return "working";
  if (hasToolResultReply && currentStatus === "permission_blocked") return "working";
  return null;
}

// Recognizes a Claude Code API/auth-error *banner* turn — the one-liner the CLI
// emits when an Anthropic request fails (expired OAuth token, overload, bad key).
// These are transient TUI state, not real conversation turns: when the CLI's
// next attempt succeeds it rewinds the banner out of its transcript and replays
// the turn for real. The daemon's file-watcher, however, has usually already
// synced the banner to a durable message — and append-only sync never un-syncs
// it, leaving a stale "Please run /login" card on a session that actually
// recovered. We detect these so the server can supersede them once a genuine
// turn follows. Anchored prefixes + a length cap keep a real assistant message
// that merely *discusses* an API error from being mistaken for a banner.
const API_ERROR_BANNER_RE =
  /^(?:please run \/login|not logged in|invalid api key|credit balance is too low|api error\b|oauth (?:token|authentication))/i;

export function isApiErrorBanner(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return false;
  return API_ERROR_BANNER_RE.test(trimmed);
}

// Decides what an addMessages batch should do about stale API-error banners.
//   - "supersede": a real turn arrived; delete banner(s) that precede it and
//     clear the pending flag. Triggered when the conversation was flagged
//     pending OR this very batch also carries a banner (recovery landing in one
//     batch). The actual deletion is timestamp-scoped by the caller so a banner
//     that is itself the newest message is never removed.
//   - "mark_pending": a banner-only batch (agent is mid-error) — remember it so
//     a later real turn can clear it.
//   - "none": ordinary traffic; no banner involved, no DB scan (keeps the write
//     hot path free of an extra read).
export type ApiErrorBatchAction = "supersede" | "mark_pending" | "none";

export function apiErrorBatchAction(input: {
  batchHasRealTurn: boolean;
  batchHasBanner: boolean;
  conversationPending: boolean;
}): ApiErrorBatchAction {
  const { batchHasRealTurn, batchHasBanner, conversationPending } = input;
  if (batchHasRealTurn && (conversationPending || batchHasBanner)) return "supersede";
  if (batchHasBanner && !batchHasRealTurn) return "mark_pending";
  return "none";
}

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

export interface SessionActivityInput {
  agentStatus?: string;
  agentStatusUpdatedAt?: number;
  /** conv.last_message_role, as synced. */
  lastMessageRole?: string;
  /** conv.last_message_preview — used only to spot an interrupt marker. */
  lastMessagePreview?: string | null;
  hasPending: boolean;
  /** conv.status ("active" | "completed"). */
  status: string;
  /** conv.updated_at. */
  updatedAt: number;
  /** Caller computes liveness from its own source (inbox maps vs a single managed row). */
  daemonAlive: boolean;
  now: number;
}

export interface SessionActivity {
  isIdle: boolean;
  isUnresponsive: boolean;
  lastRoleIsUser: boolean;
  recentlyUpdated: boolean;
}

// The composite "is this session waiting on the user / stuck" derivation shared
// by the inbox enrichment and the CLI feed. Extracted verbatim from
// enrichInboxSessionRow so the two callers can never drift on what "idle" or
// "unresponsive" means; the only per-caller difference is how `daemonAlive` is
// sourced, which is passed in.
export function deriveSessionActivity(input: SessionActivityInput): SessionActivity {
  const isInterruptMsg = !!input.lastMessagePreview && (
    input.lastMessagePreview.startsWith("[Request interrupted") ||
    input.lastMessagePreview.startsWith("[Request cancelled")
  );
  const lastRoleIsUser = input.lastMessageRole === "user" && !isInterruptMsg;
  const recentlyUpdated = (input.now - input.updatedAt) < AGENT_IDLE_GRACE_MS;

  const isUnresponsive = input.status === "active" && !input.daemonAlive && (
    (lastRoleIsUser && !recentlyUpdated) ||
    (input.hasPending && !recentlyUpdated)
  );

  const isIdle = isSessionIdle({
    agentStatus: input.agentStatus,
    agentStatusUpdatedAt: input.agentStatusUpdatedAt,
    hasPending: input.hasPending,
    lastRoleIsUser,
    recentlyUpdated,
    daemonAlive: input.daemonAlive,
    now: input.now,
  });

  return { isIdle, isUnresponsive, lastRoleIsUser, recentlyUpdated };
}

// A single, coarse "what is this session doing" label for CLI discovery and the
// `cast monitor` dashboard. Collapses the inbox's many derived flags into three
// buckets:
//   - "working":     the agent is actively producing, or has deliverable queued work.
//   - "needs_input": the agent is blocked on the user (open question / permission
//                    prompt), dead with output to read, OR a session the user
//                    pinned that has gone idle (a deliberate inversion of the web
//                    inbox, which hides pinned sessions from needs-input — here a
//                    pin means "ping me when this is free").
//   - "idle":        finished, ball in the user's court, not flagged.
// This is the server-side mirror of the web store's isSessionWaitingForInput,
// minus the client-only queued-message signal, and is the ONE place the rule
// lives — the CLI only ever string-matches the resulting work_state.
export type WorkState = "working" | "needs_input" | "idle";

export interface WorkStateInput {
  /** Heartbeat-fresh managed_sessions.agent_status, or undefined when stale/absent. */
  agentStatus?: string;
  isIdle: boolean;
  awaitingInput: boolean;
  hasPending: boolean;
  isUnresponsive: boolean;
  isPinned: boolean;
  messageCount: number;
}

// Accepted `--state` filter values for CLI discovery, normalized to a canonical
// token. "pinned" and "live" are orthogonal to work_state (they filter the
// is_pinned / is_live flags), so callers handle them specially. Returns null for
// "all"/unset/garbage so an unrecognized value transparently means "no filter".
export type WorkStateFilter = WorkState | "pinned" | "live";

export function normalizeWorkStateFilter(raw: string | undefined | null): WorkStateFilter | null {
  const v = (raw || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (v) {
    case "working":
    case "active":
    case "busy":
      return "working";
    case "needs-input":
    case "needs":
    case "needsinput":
    case "blocked":
    case "input":
    case "attention":
      return "needs_input";
    case "idle":
    case "done":
    case "waiting":
      return "idle";
    case "pinned":
    case "pin":
      return "pinned";
    case "live":
    case "running":
      return "live";
    default:
      return null;
  }
}

export function classifyWorkState(input: WorkStateInput): WorkState {
  const { agentStatus, isIdle, awaitingInput, hasPending, isUnresponsive, isPinned, messageCount } = input;
  const dead = !!agentStatus && DEAD_AGENT_STATUSES.has(agentStatus);
  const canDeliver = !isUnresponsive && !dead;
  const hasMsgs = messageCount > 0;

  // Blocked on the user right now (open AskUserQuestion poll, or a tool-use
  // awaiting approve/deny) → needs input. A poll/permission on an empty session
  // is just startup noise, so gate on having real content.
  if (awaitingInput && hasMsgs) return "needs_input";
  if (agentStatus === "permission_blocked" && hasMsgs) return "needs_input";

  // Actively producing, or carrying deliverable queued work on a live daemon.
  if (agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus)) return "working";
  if (canDeliver && hasPending) return "working";

  // Dead with output → a human needs to read/restart it.
  if (dead) return hasMsgs ? "needs_input" : "idle";

  // Settled idle: a pinned session the user flagged for follow-up surfaces in
  // needs-input; an unpinned one is just quietly idle.
  if (isIdle && hasMsgs) return isPinned ? "needs_input" : "idle";

  return "idle";
}
