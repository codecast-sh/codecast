import type { Doc } from "./_generated/dataModel";
// Single source of truth for the "agent is actively producing" set and the
// stale-status trust TTL. Re-exported so existing `from "./inboxFilters"`
// importers (incl. the tests) keep working unchanged.
import { ACTIVE_AGENT_STATUSES, TRUST_DECAYING_STATUSES, DECLARED_VERDICT_STATUSES, STATUS_TRUST_TTL_MS, AGENT_IDLE_GRACE_MS, WORK_STATES, type WorkState } from "@codecast/shared/contracts";

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

// Collapse a stale "active" status so every consumer agrees on what the agent
// is doing. The agent_status field is read in three independent places — the
// web row's isAgentActive short-circuit, the server-computed is_idle
// (deriveSessionActivity), and classifyWorkState — so coercing once at the
// enrichment boundary fixes all of them with no downstream duplication.
//
// Two independent staleness signals, both non-destructive read-time transforms
// (the stored managed_sessions.agent_status is untouched):
//   - heartbeat lapsed AND the conversation quiet for the same window → the
//     process is gone; its frozen "working" reads as "stopped". Both legs are
//     required: the heartbeat sender shares the daemon with slow maintenance
//     passes (tmux health checks, WIP snapshot sweeps), so a busy fleet can
//     miss heartbeats for minutes while provably alive — syncing messages every
//     few seconds. Coercing on heartbeat age alone filed every actively-working
//     session under NEEDS INPUT during such a stall (2026-07-20). Fresh message
//     traffic is proof of life that vetoes the coercion. Residual gap: a turn
//     sitting in a long, SILENT tool call (nothing synced for 90s+) during a
//     heartbeat stall still reads stopped — accepted, because the daemon-side
//     fix (liveness sends decoupled from slow maintenance passes) makes stalls
//     rare and the next synced output self-corrects the row.
//   - conversation quiet past the trust TTL with a live heartbeat → the daemon
//     lost the turn's idle transition and re-asserts "working" forever; reads as
//     "idle" (not "stopped") because the fresh heartbeat means the process is
//     alive — it's finished, not dead.
// Any later message bumps conv.updated_at, so a genuinely long-running turn
// re-promotes itself to "working" on its next output.
//
// The settle verdicts split on the two legs. The inferred one ("waiting", a
// transcript scrape) takes both: a wedged background task must not park a
// session forever. A DECLARED verdict ("dormant" / "done") skips the quiet-time
// leg — a nightly trigger's home is quiet for 23h by design and the agent named
// its wake — but still takes the dead-daemon leg for "dormant": a dead daemon
// cannot deliver the wake it promised, so the row must resurface as needing a
// human. "done" survives a dead daemon: the deliverable is already there and
// nothing is waiting on a process.
//
// `heartbeatAlive` defaults to true for callers that already gate on a fresh
// heartbeat (or have no managed row in hand); map-based consumers pass
// liveConvIds membership.
//
// `verifiedWaiting`: the daemon has CHECKED the open background work behind a
// "waiting" — matched each task to a live child shell of the agent process and
// re-reported it recently (open_tasks / open_tasks_at on the managed row, see
// shared/contracts/openTasks). A checked "waiting" is not a transcript guess, so
// it skips the quiet-time decay like a declared verdict: a poll on a five-hour
// build stays parked with its bar instead of resurfacing at the hour. The
// dead-daemon leg still applies — nobody is watching the shell any more.
export function trustedAgentStatus(
  agentStatus: string | undefined,
  updatedAt: number | undefined,
  now: number,
  heartbeatAlive: boolean = true,
  verifiedWaiting: boolean = false,
): string | undefined {
  if (!agentStatus) return agentStatus;
  const decays = TRUST_DECAYING_STATUSES.has(agentStatus) && !(agentStatus === "waiting" && verifiedWaiting);
  const declared = DECLARED_VERDICT_STATUSES.has(agentStatus) || (agentStatus === "waiting" && verifiedWaiting);
  if (!decays && !declared) return agentStatus;
  const quietPastHeartbeat = updatedAt === undefined || now - updatedAt >= HEARTBEAT_ALIVE_MS;
  if (!heartbeatAlive && quietPastHeartbeat && agentStatus !== "done") return "stopped";
  if (decays && updatedAt !== undefined && now - updatedAt >= STATUS_TRUST_TTL_MS) return "idle";
  return agentStatus;
}

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
import { isApiErrorBanner as isApiErrorBannerFn } from "@codecast/shared/contracts";

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
// an image. A banner is not one, and neither is a system notice or an empty
// meta row — those say nothing about whether a block lifted.
export function isRealTurn(m: TurnShape): boolean {
  if (isBannerTurn(m)) return false;
  if (m.role === "assistant") return !!m.content?.trim() || (m.tool_calls?.length ?? 0) > 0;
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

// Daemon liveness window shared by the needs-input check, the inbox scan and
// the projection deadlines (conversations.ts imports it).
export const HEARTBEAT_ALIVE_MS = 90 * 1000;

