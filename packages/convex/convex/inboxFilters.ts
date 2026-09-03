import type { Doc } from "./_generated/dataModel";
// Single source of truth for the "agent is actively producing" set and the
// stale-status trust TTL. Re-exported so existing `from "./inboxFilters"`
// importers (incl. the tests) keep working unchanged.
import { ACTIVE_AGENT_STATUSES, TRUST_DECAYING_STATUSES, DECLARED_VERDICT_STATUSES, STATUS_TRUST_TTL_MS, AGENT_IDLE_GRACE_MS, WORK_STATES, isSessionIdle, type WorkState } from "@codecast/shared/contracts";

export { ACTIVE_AGENT_STATUSES, STATUS_TRUST_TTL_MS, AGENT_IDLE_GRACE_MS, WORK_STATES, type WorkState };
// The work-state classifier lives in @codecast/shared/contracts/inboxProjection
// (the ONE placement function the liveness overlay, the CLI inbox and every
// client share — sync-convergence C3). Re-exported so existing importers keep
// working unchanged.
export { classifyWorkState, DEAD_AGENT_STATUSES, type WorkStateInput } from "@codecast/shared/contracts";

export type ConversationDoc = Doc<"conversations">;

// The pure inbox visibility rule (subagent/orphan drop, noise titles, killed
// unless pinned, completed-and-blank) lives in
// @codecast/shared/contracts/inboxProjection — ONE implementation serves the
// server scan and every replica's working-set selection (sync-convergence C4).
// Re-exported so existing `from "./inboxFilters"` importers keep working.
export { NOISE_TITLE_PREFIXES, isNoiseTitle, isOrphanOrSubagent, shouldShowInInbox } from "@codecast/shared/contracts";
import { shouldShowInInbox } from "@codecast/shared/contracts";

// The three DISTINCT ways a session leaves the active inbox. They were reported
// as a single "dismissed" figure back when kill was an event rather than a
// state, which hid the one difference that matters operationally — whether the
// agent is still running:
//   stashed   — hidden from the inbox, agent still ALIVE
//   dismissed — hidden from the inbox, agent TORN DOWN
//   killed    — retired; the authoritative marker, and it outranks both
// Killed takes precedence because the two kill surfaces write different fields:
// applyHideTransition (cast kill, dismiss→kill) stamps inbox_dismissed_at
// ALONGSIDE inbox_killed_at, while the killSession command stamps the marker
// alone. Checking dismissed first would file one user-visible state under two
// different names depending on which surface did the killing.
//
// Dismissed then outranks stashed, matching isSessionStashed in the web's
// inboxStore ("Dismiss wins: a stashed session that later gets dismissed
// renders in the Dismissed bucket, never both"). Dismiss is also the stronger
// claim: it means the agent was torn down, so a stash stamp that survives it is
// stale history, and calling such a row "stashed" would assert a live agent
// there isn't one.
//
// SCOPE OF THAT AGREEMENT — it holds for UNKILLED rows only, and the difference
// is deliberate. The web models this as two ORTHOGONAL axes: a bucket
// (active | dismissed | stashed) plus an independent isSessionKilled flag, so a
// killed row still carries whichever bucket its hide stamps imply. This is a
// SINGLE-AXIS partition, because its job is counting: every row must land in
// exactly one tally or the figures overlap. The two therefore agree on every
// combination with no kill marker and diverge on every one with it — e.g. a
// stashed-then-killed row (killSession stamps the marker alone and never clears
// inbox_stashed_at) is "killed" here and bucket=stashed + killed=true there.
// Same facts, different projection; neither is wrong, and inboxFilters.test.ts
// cross-checks the unkilled rows against the real web helpers so this stays
// true rather than merely asserted.
export type RetirementState = "killed" | "dismissed" | "stashed";

export function classifyRetirement(conv: ConversationDoc): RetirementState | null {
  if (conv.inbox_killed_at) return "killed";
  if (conv.inbox_dismissed_at) return "dismissed";
  if (conv.inbox_stashed_at) return "stashed";
  return null;
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
  if (parent.inbox_dismissed_at || parent.inbox_stashed_at) return false;
  return shouldShowInInbox(parent);
}

// AGENT_IDLE_GRACE_MS (re-exported above) lives in @codecast/shared/contracts:
// the anti-flicker grace before a finished agent is treated as idle, shared
// with the web client's statusless-row sweep so both sides settle a quiet
// session on the same clock.

// STATUS_TRUST_TTL_MS (imported from @codecast/shared/contracts): how long a
// daemon-reported "active" status is trusted with no new synced activity. When
// the daemon loses a turn's idle transition (a dropped Stop hook, Codex's
// sleep-killed idle timer) it re-asserts the last "working" on every heartbeat,
// and because that heartbeat keeps the managed row "live" the 90s
// heartbeat-staleness coercion never fires — so the session would be pinned in
// the inbox's WORKING bucket indefinitely. Past the TTL we stop trusting it (see
// trustedAgentStatus). AskUserQuestion / permission blocks never reach here as
// "active" (the caller routes them to needs-input first).

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

// Claude Code API/auth/limit-error *banner* detection — the one-liner the CLI
// emits when an Anthropic request fails (expired OAuth token, overload, bad
// key, usage/session limit). These are transient TUI state, not real
// conversation turns: when the CLI's next attempt succeeds it rewinds the
// banner out of its transcript and replays the turn for real. The daemon's
// file-watcher, however, has usually already synced the banner to a durable
// message — and append-only sync never un-syncs it, leaving a stale "Please
// run /login" card on a session that actually recovered. We detect these so
// the server can supersede them once a genuine turn follows. The classifier
// lives in @codecast/shared/contracts as the single source of truth shared
// with the web client's ApiErrorCard rendering.
export { isApiErrorBanner, classifyApiErrorBanner, CLIENT_ERROR_BANNER_PREFIX, blockedContinueClientId, BLOCKED_BANNER_KINDS, CONTINUE_BANNER_KINDS } from "@codecast/shared/contracts";
import { isApiErrorBanner as isApiErrorBannerFn, isNoResponseStub } from "@codecast/shared/contracts";

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

// The turn shape the park flag reasons over — an incoming addMessages row or
// a stored messages doc, whichever the caller holds.
export interface TurnShape {
  role: string;
  content?: string | null;
  tool_calls?: readonly unknown[] | null;
  tool_results?: readonly unknown[] | null;
  images?: readonly unknown[] | null;
}

// A Claude Code API-error banner turn (see apiErrorBanner.ts).
export function isBannerTurn(m: TurnShape): boolean {
  return m.role === "assistant" && isApiErrorBannerFn(m.content);
}

// A genuine turn: assistant text or a tool call, user text, a tool result or
// an image. A banner is not one, and neither is a system notice, an empty
// meta row, or the CLI's synthetic "No response requested." stub — those say
// nothing about whether a block lifted. The stub follows every limit banner
// the resume hook pokes: counting it as a turn cleared the flag and painted a
// still-parked session "resolved".
export function isRealTurn(m: TurnShape): boolean {
  if (isBannerTurn(m)) return false;
  if (m.role === "assistant") {
    if ((m.tool_calls?.length ?? 0) > 0) return true;
    return !!m.content?.trim() && !isNoResponseStub(m.content);
  }
  if (m.role === "user") {
    return !!m.content?.trim() || (m.tool_results?.length ?? 0) > 0 || (m.images?.length ?? 0) > 0;
  }
  return false;
}

// The row the park flag keys on is the newest BANNER-OR-REAL-TURN in the
// batch, never the newest row outright. Claude Code writes a system notice
// ("Remote Control disconnected") right after a limit banner when the account
// switches, and the daemon's retry flush ships both in one addMessages call.
// The notice is newer by timestamp but says nothing about the block; judging
// it "newest" left the banner unflagged, so the session rendered resolved
// while still parked. Ties keep the later row, like the reduce it replaces.
export function newestSignificantMessage<T extends TurnShape & { timestamp?: number }>(
  msgs: readonly T[],
): T | undefined {
  let best: T | undefined;
  for (const m of msgs) {
    if (!isBannerTurn(m) && !isRealTurn(m)) continue;
    if (!best || (m.timestamp || 0) >= (best.timestamp || 0)) best = m;
  }
  return best;
}

// The next value of conversations.pending_api_error after a write. A banner as
// the newest message parks the session; a real turn (assistant text/tool call,
// user text/tool result/image) releases it. Anything else — a system notice
// such as "Remote Control disconnected", an empty meta row — says nothing about
// whether the block lifted, so the flag keeps its current value. Clearing it
// on such traffic made a still-parked session render "resolved".
export function nextPendingApiError(input: {
  newestIsBanner: boolean;
  batchHasRealTurn: boolean;
  conversationPending: boolean;
}): boolean {
  const { newestIsBanner, batchHasRealTurn, conversationPending } = input;
  if (newestIsBanner) return true;
  if (batchHasRealTurn) return false;
  return conversationPending;
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
// The newest message is a real user turn: a non-interrupt user message. One
// rule for the enrichment, the notifier and the overlay's replicated
// `last_role_is_user` fact (ct-47609).
export function lastRoleIsUserOf(lastMessageRole: string | undefined, lastMessagePreview: string | null | undefined): boolean {
  const isInterruptMsg = !!lastMessagePreview && (
    lastMessagePreview.startsWith("[Request interrupted") ||
    lastMessagePreview.startsWith("[Request cancelled")
  );
  return lastMessageRole === "user" && !isInterruptMsg;
}

export function deriveSessionActivity(input: SessionActivityInput): SessionActivity {
  const lastRoleIsUser = lastRoleIsUserOf(input.lastMessageRole, input.lastMessagePreview);
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

// How recently a subagent must have produced output to keep its parent in
// "working" on the strength of recent activity alone. Wider than the
// AGENT_IDLE_GRACE so a child mid-tool-call (quiet but live) doesn't drop its
// parent out of "working" prematurely.
export const SUBAGENT_PRODUCING_GRACE_MS = 5 * 60 * 1000;

// Whether a subagent child is still PRODUCING, and so should keep its idle
// parent classified as "working" (the orchestrator-waiting-on-its-workers case).
// The trap this guards against: "alive" is not "working". `convStatus` is the
// conversation status — "active" for nearly every non-completed conversation,
// never the agent status — and a managed session keeps heartbeating (so the
// caller's `isLive` stays true) for hours after its agent has gone idle, e.g. a
// forked subagent that finished but whose daemon is still up. Either signal
// alone would pin a long-finished parent in "working" forever. So we accept two
// independent proofs of real work:
//   - recent output: the child synced something within the grace window. This
//     stands alone and covers Task-tool subagents that have no managed session
//     of their own (no agent_status to read), so liveness can't be checked.
//   - a live session whose agent_status is genuinely active. The caller passes
//     the child's agent_status already coerced for heartbeat staleness (so a
//     re-asserted-stale "working" on a long-quiet child reads as not-active).
export function subagentKeepsParentWorking(input: {
  isSubagent: boolean;
  convStatus: string;
  updatedAt: number;
  isLive: boolean;
  agentStatus: string | undefined;
  now: number;
}): boolean {
  if (!input.isSubagent || input.convStatus !== "active") return false;
  if (input.now - input.updatedAt < SUBAGENT_PRODUCING_GRACE_MS) return true;
  return input.isLive && ACTIVE_AGENT_STATUSES.has(input.agentStatus ?? "");
}

// The stamp-currency rules (the user's dormant gesture, the settle verdict)
// live in @codecast/shared/contracts/inboxProjection — the shared row placement
// needs them, and one rule must decide "does this stamp still describe the row"
// on every surface. Re-exported for existing importers.
export { isUserDormant, isSettleVerdictCurrent } from "@codecast/shared/contracts";

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
    case "done":
    case "complete":
    case "completed":
    case "delivered":
      return "done";
    // "waiting" is the agent_status of a finished turn parked on live background
    // work — a settle verdict, so the filter alias follows it to dormant.
    case "dormant":
    case "waiting":
    case "parked":
    case "asleep":
      return "dormant";
    case "idle":
    case "blank":
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

// The "waiting" flavor behind a needs_input verdict — the server mirror of the
// web's waitingSoundKey kind (useSyncInboxSessions), so the needs-input push
// and the client idle sound describe the same transition. Combined with
// message_count it forms the notification dedupe key: a new turn (count grew)
// or a different flavor notifies again; a re-assertion of the same waiting
// episode does not.
export function needsInputKind(input: {
  awaitingInput: boolean;
  agentStatus?: string;
  isUnresponsive: boolean;
}): string {
  if (input.awaitingInput) return "awaiting_input";
  if (input.agentStatus === "permission_blocked") return "permission_blocked";
  return input.agentStatus || (input.isUnresponsive ? "unresponsive" : "idle");
}

// Scheduling delays for the needs-input push re-check (notifications.checkNeedsInput).
//
// Idle: isSessionIdle only settles AGENT_IDLE_GRACE_MS after the status change
// (the same grace that keeps the web from flickering to "needs input" the
// instant a turn ends), so the check fires just past it — the first moment the
// verdict can be true, and the same moment the client sound fires.
export const NEEDS_INPUT_IDLE_CHECK_DELAY_MS = AGENT_IDLE_GRACE_MS + 5_000;
// Permission blocks are needs_input immediately, but the daemon creates its
// pending_permissions record (with its own push) asynchronously right after
// the status write — wait for it so the record-existence dedupe is reliable.
export const NEEDS_INPUT_PERMISSION_CHECK_DELAY_MS = 10_000;
// AskUserQuestion arrival: the poll is authoritative in the messages table the
// moment it syncs; the small delay just lets the same batch's conversation
// patch (message_count) settle before the dedupe key is computed.
export const NEEDS_INPUT_AUQ_CHECK_DELAY_MS = 2_000;

// The daemon liveness window, the status trust rule and the idle rule live in
// the shared contracts now (sync-convergence ct-47609: a replica re-derives
// is_idle from replicated facts at any instant, so the rule has ONE home).
// Re-exported so existing `from "./inboxFilters"` importers keep working.
export { HEARTBEAT_ALIVE_MS, trustedAgentStatus, isSessionIdle, type SessionIdleInput } from "@codecast/shared/contracts";

