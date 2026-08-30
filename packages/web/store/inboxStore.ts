import { create } from "zustand";
import { useSyncExternalStore, useRef } from "react";
import {
  mutativeMiddleware,
  action,
  asyncAction,
  receiptAsyncAction,
  DispatchNotWiredError,
  isParkedDispatchError,
  sync,
  type DurableCreateContinuation,
} from "./mutativeMiddleware";
import { adoptWorkspaceSnapshot, createWorkspace, serializeWorkspace, hydrateWorkspace, autoAllowed as wsAutoAllowedPure, isSessionRailOpen, isCommentRailOpen, SESSION_LIST_PANE, TERMINAL_PANE, type PersistedWorkspace, showPane, hidePane, togglePane, setPresentation as wsSetPresentationPure, setSize as wsSetSizePure, promote as wsPromotePure, type WorkspaceState, type SlotId, type Pane, type Presentation } from "./workspace";
import { applyWorkbench as applyWorkbenchPure, captureWorkbench, chipFilterOf, resolveWorkbenchFilter, type WorkbenchSnapshot } from "./workbench";
import { declareViewNav, hasViewNavigated, recordNavEvent, type ViewNavSource } from "./viewNav";
import { applySyncTable, applySyncRecord, type PendingEntry } from "./syncProtocol";
import { isDraft, original } from "mutative";
import { soundDismiss, soundKill } from "../lib/sounds";
import { loadCache, writePatchesToIDB, setHydrating, loadConversationMessages, writeConversationMessages, writeConversationUserMessages, enqueueDispatch, removeDispatch, loadOutbox, salvageLocalFirstV2Data, PERSISTENCE_AVAILABLE } from "./idbCache";
import {
  DISPATCH_TABLE_MAP,
  HYDRATION_CRITICAL_KEYS,
  HYDRATION_DEFERRED_KEYS,
  REGISTRY_SYNC_OPTS,
  collectionInitialState,
  hydrationMergeStrategy,
  type RegisteredCollectionSlots,
} from "./clientSyncRegistry";

// Sync-log cursor key (docs/architecture/sync-log-migration.md D7). ONE
// definition — the applier (useSyncChangeFeed) persists cursors under it and
// stampSyncAck's immediate-retire branch reads it; a second spelling would
// silently break the retire race it exists for.
export function syncLogScopeMetaKey(scopeKey: string): string {
  return `synclog:v1:${scopeKey}`;
}

// Reverse of the registry's storeKey→server-table dispatch map, for stamping
// sync-log acks onto the pending entries a dispatched patch created (one server
// table can back several store keys — conversations backs both `sessions` and
// `conversations`).
const TABLE_TO_STORE_KEYS: Record<string, string[]> = {};
for (const [storeKey, cfg] of Object.entries(DISPATCH_TABLE_MAP)) {
  (TABLE_TO_STORE_KEYS[cfg.table] ??= []).push(storeKey);
}
import { makeCollectionSig } from "./wakeSig";
import { broadcastGesture, BRIDGED_FIELDS, type BridgedField, type GestureMessage } from "./gestureBridge";
// Single source of truth for the agent-status contract, shared with the Convex
// backend and the CLI daemon. See packages/shared/contracts/agentStatus.ts.
import { type AgentStatus, ACTIVE_AGENT_STATUSES, isLivenessStale, modelOptionKey } from "@codecast/shared/contracts";
import { liftQuestions, type QuestionResolutions } from "../lib/decisionQueue";
import type { OpenTaskReport } from "@codecast/shared/contracts";
import { isSubagentConversation, nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";

export type { PendingEntry } from "./syncProtocol";

// A tracked create can outlive the UI's bounded resolver window while the
// durable outbox remains the owner of the command. Subclass the
// existing parked error so every send caller keeps the optimistic message
// pending and the normal rekey continuation can redrive it later.
export class SessionCreatePendingError extends DispatchNotWiredError {
  constructor() {
    super("createSession", true);
    this.name = "SessionCreatePendingError";
    this.message = "Session creation is still pending durable delivery";
  }
}

export async function awaitTrackedSessionCreateResult(
  create: Promise<string>,
  timeoutMs = 30_000,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      create,
      new Promise<string>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SessionCreatePendingError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Convex-id check lives in lib/entityLinks (the entity-routing source of truth).
// What the sidebar-hosted create modal is showing. One name, three spellings
// collapsed (the field, the opener's parameter, and the action).
export type CreateModalKind = 'task' | 'plan' | 'doc' | 'chat' | 'huddle';

// Imported for internal use AND re-exported so the many call sites that import
// `isConvexId` from the store keep working.
import { isConvexId } from "../lib/entityLinks";
import { pathOnMyMachines, type MachineCandidate } from "../lib/machinePicker";
import { conversationTabPath } from "../lib/pathLabel";
import { healTabPaths, isNonTabRoute, shellTabPath } from "../lib/tabRoutes";
import { divertSessionOpen } from "../lib/openIntent";
import type { PalettePick } from "../lib/palettePick";
export { isConvexId };

// Canonical entity-derivation helpers live in lib/liveEntities. Re-exported here
// so existing call sites that import from the store keep working.
export { resolveAssigneeInfo, resolveSessionAuthor, computePlanProgress, mergeLiveTasks } from "../lib/liveEntities";
import { deriveDocDisplayTitle, isForeignSession } from "../lib/liveEntities";
import { DEFAULT_SETTINGS_SECTION, type SettingsSectionId } from "../lib/settingsSections";
import type { PendingComment } from "../lib/quoteFormat";
import type { Comment as CommentRow } from "../lib/commentThread";
import { pushInboxViewHistory, isApplyingViewHistory, sameInboxView, type InboxViewSnapshot } from "../lib/inboxViewHistory";
import { sessionFocusKind, type SessionFocusKind } from "../lib/inboxRouting";
// Team chat lives in its own slice: four delta-synced collections plus the
// optimistic writers over them. Spread into the config below, and its state
// shape is folded into InboxStoreState so the draft type covers it.
import {
  createChatSlice,
  CHAT_SYNC_REGISTRY,
  selectChannelReadMarker,
  type ChatSliceState,
} from "./chatSlice";
// Re-exported so chat surfaces import their selectors from the store, like every
// other view does, instead of reaching into the slice file.
export {
  selectChatRail,
  selectChannelMessages,
  selectChannelReadMarker,
  selectThreadReplies,
  selectChatReactions,
  chatReactionSyncOpts,
  chatSendState,
  chatReactionStubId,
  newChatMessageClientId,
  newChatChannelClientId,
  CHAT_CHANNEL_STUB_PREFIX,
  CHAT_MESSAGE_STUB_PREFIX,
  CHAT_READ_STUB_PREFIX,
  CHAT_REACTION_STUB_PREFIX,
} from "./chatSlice";
export type {
  ChatChannelRow,
  ChatMessageRow,
  ChatReadRow,
  ChatReactionRow,
  ChatRailRow,
  ChatRailChannel,
  ChatNotifyLevel,
  ChatSendOptions,
} from "./chatSlice";
export type { ThreadInboxRow, ThreadKind, ThreadLastReply } from "./threadTypes";
export { threadRowId } from "./threadTypes";
import type { ThreadCardOpenEntry } from "./threadTypes";
export type { ThreadCardOpenEntry } from "./threadTypes";

// Critical UI prefs mirrored to localStorage so they're available
// synchronously at module load — avoids a layout flash between first paint
// and IDB hydration. The IDB-backed clientState remains the source of truth
// across tabs; localStorage is just a sync-readable cache for first-paint
// values that affect layout. Keep this set TINY — every key here adds
// localStorage churn on every change.
// pinned_surfaces joins the critical set for the same reason sidebar_collapsed
// is here: it decides the ARRANGEMENT at first paint. Seeded from localStorage
// synchronously, a pinned split renders as a split immediately instead of
// flashing a peek overlay until the server clientState arrives.
const CRITICAL_UI_KEYS = ["sidebar_collapsed", "zen_mode", "inbox_shortcuts_hidden", "inbox_flat_view", "workspace"] as const;
const CRITICAL_PREFS_LS_KEY = "codecast-critical-ui";

function readCriticalUiPrefs(): Record<string, any> {
  // Guard on localStorage itself (not window): React Native may define `window`
  // without a DOM Storage, and SSR has neither.
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CRITICAL_PREFS_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const out: Record<string, any> = {};
    for (const k of CRITICAL_UI_KEYS) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    return out;
  } catch { return {}; }
}

function writeCriticalUiPrefs(partial: Record<string, any>) {
  if (typeof localStorage === "undefined") return;
  let toWrite: Record<string, any> | null = null;
  for (const k of CRITICAL_UI_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, k)) {
      if (!toWrite) toWrite = {};
      toWrite[k] = partial[k];
    }
  }
  if (!toWrite) return;
  try {
    const existing = JSON.parse(localStorage.getItem(CRITICAL_PREFS_LS_KEY) || "{}");
    localStorage.setItem(CRITICAL_PREFS_LS_KEY, JSON.stringify({ ...existing, ...toWrite }));
  } catch {}
}

// The arrangement (not its contents) is a durable preference: mirror it into
// the ui bag on every slot mutation so it survives reload and rides the same
// per-device sync as the other layout prefs. In CRITICAL_UI_KEYS, so the shell
// paints the right arrangement immediately instead of flashing a default.
function persistWorkspace(draft: any) {
  // A detached tab window keeps its own in-memory arrangement but never
  // persists it — the ui bag and device key are the MAIN window's layout, and
  // a breakout window writing them would reshape every other window's frame.
  if (typeof window !== "undefined" && (window as any).__CODECAST_ELECTRON__?.isTabWindow === true) return;
  const ws = draft.workspace as WorkspaceState;
  if (!draft.clientState) draft.clientState = {};
  if (!draft.clientState.ui) draft.clientState.ui = {};
  // Shared slots follow the user like any layout pref…
  draft.clientState.ui.workspace = serializeWorkspace(ws, "shared");
  writeCriticalUiPrefs({ workspace: draft.clientState.ui.workspace });
  // …device slots never leave this browser profile (SLOT_PERSISTENCE).
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DEVICE_WORKSPACE_KEY, JSON.stringify(serializeWorkspace(ws, "device")));
    }
  } catch {}
}

const DEVICE_WORKSPACE_KEY = "codecast-device-workspace";

function readDeviceWorkspace(): any {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(DEVICE_WORKSPACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Region "is it open" questions are now selectors over slot state, not stored
// booleans — one source of truth for the right edge.
/** Nav is folded to its hover-peek edge (the old ui.sidebar_collapsed). */
export const selectNavCollapsed = (s: { workspace: WorkspaceState }) => s.workspace.nav.presentation === "collapsed";

export const selectSessionRailOpen = (s: { workspace: WorkspaceState }) => isSessionRailOpen(s.workspace);
export const selectCommentRailOpen = (s: { workspace: WorkspaceState }) => isCommentRailOpen(s.workspace);
export const selectSessionRailUserClosed = (s: { workspace: WorkspaceState }) =>
  !wsAutoAllowedPure(s.workspace, "context", SESSION_LIST_PANE);

export function getProjectName(gitRoot?: string, projectPath?: string): string {
  const path = gitRoot || projectPath;
  if (!path) return "unknown";
  return path.split("/").filter(Boolean).pop() || "unknown";
}

// -- Types --

export type PlanRef = {
  _id: string;
  short_id: string;
  title: string;
  status: string;
};

export type TaskRef = {
  _id: string;
  short_id: string;
  title: string;
  status: string;
};

// Lightweight shapes returned by `*.webMentionList` server queries. Only the
// fields the mention picker actually renders, kept thin so we can hold a
// cross-team index in memory comfortably.
export type MentionTaskItem = {
  _id: string;
  title: string;
  short_id: string;
  status: string;
  priority: string;
  updated_at: number;
  team_id?: string | null;
  user_id?: string | null;
};

export type MentionDocItem = {
  _id: string;
  title: string;
  doc_type: string;
  source_file?: string | null;
  updated_at: number;
  team_id?: string | null;
  user_id?: string | null;
};

export type MentionPlanItem = {
  _id: string;
  title: string;
  short_id: string;
  status: string;
  goal?: string;
  updated_at: number;
  team_id?: string | null;
  user_id?: string | null;
};

export type PlanItem = {
  _id: string;
  short_id: string;
  title: string;
  goal?: string;
  status: string;
  source: string;
  // Workspace: set = that team's plan, unset = personal (lib/workspaceScope).
  team_id?: string;
  // ACCESS key ("team:<id>" | "user:<id>"), server-stamped; independent of
  // team_id (routing). Views filter on it via lib/workspaceScope.
  workspace?: string;
  progress?: { total: number; done: number; in_progress: number; open: number };
  task_count?: number;
  session_count?: number;
  created_at: number;
  updated_at: number;
};

// The collections the cross-entity change feed can upsert/prune. Keep in sync
// with hooks/useSyncChangeFeed's ENTITY_COLLECTION map.
export type FeedCollection =
  | "sessions"
  | "tasks"
  | "docs"
  | "plans"
  | "projects"
  ;

export type ProjectItem = {
  _id: string;
  short_id?: string;
  title: string;
  description?: string;
  status: string;
  /** Workspace truth (server row field): set = team project, absent = personal. */
  team_id?: string | null;
  // ACCESS key ("team:<id>" | "user:<id>"), server-stamped; independent of
  // team_id (routing). Views filter on it via lib/workspaceScope.
  workspace?: string;
  color?: string;
  icon?: string;
  target_date?: number;
  labels?: string[];
  task_counts: { total: number; done: number; in_progress: number };
  plan_count: number;
  doc_count: number;
  active_plan_count: number;
  created_at: number;
  updated_at: number;
};

export type InboxSession = {
  _id: string;
  session_id: string;
  title?: string;
  subtitle?: string;
  updated_at: number;
  started_at?: number;
  project_path?: string;
  git_root?: string;
  git_branch?: string;
  agent_type: string;
  // Local-only create intent for ContextChat stubs. Persisted with the stub so
  // an outbox-cap/boot heal can reissue createSession without losing the
  // originating task/doc/plan relation; the server row never needs this field.
  _linkedObject?: { type: string; id: string };
  // Local-only recovery metadata for a cross-agent continuation. The server
  // represents it as parent_conversation_id (not forked_from), but a stranded
  // stub must still reissue forkFromMessage with target_agent_type rather than
  // degrade into a blank createSession.
  _forkTargetAgentType?: string;
  // Local-only launch intent captured when createSession is enqueued. If the
  // create parks and the user changes a picker on the stub before it lands,
  // rekey reconciliation compares the latest row with this frozen snapshot and
  // durably reconfigures the blank real session before sending its first turn.
  _launchSnapshot?: SessionLaunchSnapshot;
  // Local-only filing intent for a session created while a label filter was
  // focused. It survives a parked create/reload and is cleared only after the
  // authoritative bucket-assignment row syncs back.
  _postCreateBucketId?: string;
  // Local-only "kept draft" marker for a deferred compose stub the user chose
  // to keep instead of abandoning. It is what makes a 0-message blank VISIBLE
  // in the inbox (categorizeSessions' engaged-blank gate) and immune to the
  // orphaned-stub ghost sweep until the draft is sent or the row dismissed.
  _hasDraft?: boolean;
  // Last-known model id (e.g. "claude-opus-4-8"); conversations can switch
  // models mid-stream. Shown as an inbox badge when ui.show_model_badge is on.
  model?: string | null;
  effort?: string | null;
  // Per-session stable-context launch override and feed exclusions. These are
  // local-only while a new-session stub is pending, then ride create/reconfigure.
  stable_mode?: string;
  stable_exclude?: string[];
  message_count: number;
  idle_summary?: string;
  // The agent's pinned "where this thread stands" line (`cast state`), with the
  // clock and message_count from when it was written. The card renders its
  // headline in place of idle_summary and dims it as the gap grows — see
  // shared/contracts/threadState.
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
  // Declared tri-state of that line: "working" | "blocked" | "done". Changes
  // only on a state write, so thread_state_at in the wake signature covers it.
  thread_state_status?: string | null;
  is_idle: boolean;
  // True when an AskUserQuestion poll is open and unanswered. The agent is
  // blocked on the user, so this always means "needs input" regardless of the
  // raced agent_status. Derived server-side from message data.
  awaiting_input?: boolean;
  is_unresponsive?: boolean;
  is_connected?: boolean;
  has_pending: boolean;
  agent_status?: AgentStatus;
  tmux_session?: string | null;
  permission_mode?: string | null;
  // When the agent process behind this session started. Background watches and
  // monitors armed before it belong to a process that has been replaced, so
  // they are dead however alive the session is (see monitorRows).
  agent_started_at?: number | null;
  // The daemon's verified open background work (shared/contracts/openTasks) and
  // when it last checked. Overlay-borne. Lets the inbox draw a "↳ Background …"
  // row without this conversation's messages, and tells the message-derived
  // rows which watches the daemon found dead.
  open_tasks?: OpenTaskReport[] | null;
  open_tasks_at?: number | null;
  is_deferred?: boolean;
  // The user's park gesture ("a machine owns this"), current per the server's
  // inbox_dormant_at >= updated_at rule — same contract as is_deferred. The raw
  // stamp rides along so the optimistic write can set both.
  is_dormant?: boolean;
  inbox_dormant_at?: number | null;
  // The settle classifier's verdict for the CURRENT settle (server nulls a
  // stale one), consulted only when the agent made no declaration of its own.
  settle_verdict?: "done" | "needs_input" | "dormant" | null;
  is_pinned?: boolean;
  // When the user pinned this session (Date.now() ms). Drives a stable order in
  // the Pinned group so cards don't reshuffle on agent status churn.
  inbox_pinned_at?: number | null;
  inbox_dismissed_at?: number | null;
  // Stash = set aside WITHOUT killing. Hides the session from the active
  // buckets into the Stashed group (above Dismissed) while the agent keeps
  // running. Same absolute-flag semantics as dismiss; a dismiss clears it.
  inbox_stashed_at?: number | null;
  // The RETIRED marker — the user tore this session down. Set by every kill
  // surface (`cast kill`, the web killSession command, applyHideTransition's
  // kill branch) and outranks every other state signal: a killed row is never
  // "working" and never "waiting for input", however stale its has_pending /
  // agent_status still are. Cleared only by a sanctioned revival (an explicit
  // send, Restart, undismiss) — see classifyWorkState in convex/inboxFilters.ts,
  // whose precedence the client predicates below mirror.
  inbox_killed_at?: number | null;
  last_user_message?: string | null;
  // Newest image in the conversation (server-denormalized, see convex schema).
  // Presence doubles as "this session has images"; rendered as the inbox row
  // thumbnail when the inbox_image_thumbs pref is on.
  image_preview_url?: string | null;
  // Teammate comment threads (message/code/global anchors) still unresolved —
  // the card's "someone flagged this" chip. Server-derived on the inbox row.
  open_comment_threads?: number;
  // Who spoke last in those open threads and what they said (denormalized by
  // comments.refreshCommentSignal). author_id is a users id string or "agent";
  // the chip mutes itself when the viewer spoke last.
  last_comment_author?: string | null;
  last_comment_author_id?: string | null;
  last_comment_excerpt?: string | null;
  last_comment_at?: number | null;
  session_error?: string;
  // True when the session's latest turn is an unresolved Claude Code auth/API
  // error banner ("Please run /login · API Error: 401 …") — the CLI was signed
  // out / rate-limited mid-turn and is parked waiting on the user to
  // re-authenticate or retry. Surfaced by the server; routes the row to
  // needs-input and shows a distinct "login" badge. Self-clears when a real
  // turn supersedes the banner.
  pending_api_error?: boolean;
  // "auth" | "limit" | "error" | "connection" | "fatal" — which banner family
  // parked the session; picks the badge label ("login" / "limit" / "dropped" /
  // "failed"; self-retrying "error" gets none).
  pending_api_error_kind?: string | null;
  // When the block landed (the newest banner message's timestamp) — renders
  // the ticking "Xm ago" on the blocked-sessions banner and its rows.
  pending_api_error_at?: number | null;
  implementation_session?: { _id: string; title?: string };
  is_subagent?: boolean;
  parent_conversation_id?: string;
  // Visible-child pointer: the session that spawned this one (agent-team
  // teammate → its lead). Unlike parent_conversation_id it does NOT mark the
  // row a subagent — the card stays top-level; it only powers the parent
  // click-through. agent_team_name/agent_name identify the teammate so a
  // name in a transcript can resolve to the sibling session carrying it.
  spawned_by_conversation_id?: string | null;
  agent_team_name?: string | null;
  agent_name?: string | null;
  active_plan?: PlanRef;
  active_task?: TaskRef;
  worktree_name?: string | null;
  worktree_branch?: string | null;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean;
  workflow_run_status?: string | null;
  workflow_run_name?: string | null;
  workflow_run_agents_done?: number | null;
  workflow_run_agents_total?: number | null;
  workflow_run_activity?: string | null;
  workflow_run_started_at?: number | null;
  // The schedule (agent_tasks row) that spawned this conversation as a run.
  // Lets the sidebar badge/strip attribute any historical run to its schedule.
  agent_task_id?: string | null;
  // Harness /loop state (server-folded from ScheduleWakeup / wakeup-fire
  // messages; see convex/loopState.ts). An armed loop rows this session into
  // the inbox trigger set like an armed trigger. Never "stopped" here — the
  // server projects tombstones as null.
  loop_state?: {
    status: "armed" | "waking";
    wakeup_at: number;
    armed_at: number;
    fired_at?: number;
    event_at: number;
    reason?: string;
    prompt?: string;
  } | null;
  forked_from?: string | null;
  parent_message_uuid?: string | null;
  // Messages inherited from the parent up to the fork point. Lets the branch
  // map show this branch's own size (message_count - fork_copied) when the row
  // is sourced from the session cache rather than the fork-details payload.
  fork_copied?: number;
  icon?: string;
  icon_color?: string;
  // Kept-for-later flag. Drives the Favorites top-level view (a long-term set,
  // grouped by project) — the same session cache, filtered. Set optimistically
  // by toggleFavorite and carried on both the inbox and favorites server rows.
  is_favorite?: boolean;
  dismissed_at?: number;
  team_id?: string | null;
  is_private?: boolean;
  // Which device currently runs this session (null = unassigned; auto-routing
  // picks the most-recently-active local machine on next send).
  owner_device_id?: string | null;
  // LOCAL-ONLY, blank sessions only: the machine the user picked in the
  // new-session row. A request, not a fact — it rides the create (see
  // createSessionFromStub) and routing may still fall back, after which
  // owner_device_id is the truth. Never written to the server as a field.
  target_device_id?: string | null;
  // The session's author (conversation.user_id). The inbox is user-scoped, so a
  // synced row is always the current user's own — but a teammate's session can be
  // INJECTED into this same cache (deep-link / search / command-palette open). The
  // card shows the author only when this isn't the current user. author_name/avatar
  // are the source-provided display fallback for injected rows whose author isn't on
  // the live team roster; otherwise the name/avatar derive from the roster by user_id.
  user_id?: string;
  author_name?: string | null;
  author_avatar?: string | null;
  // Second-party owner (the member routed to steer a session run by another
  // account) and the caller-relative "this session is mine to triage" verdict,
  // both stamped by the server (computeInboxSessions). Team mode reads these to
  // keep a foreign teammate row READ-ONLY — dismiss/stash/pin/kill mutate global
  // conversation fields, so acting on a teammate's card would hide it from them.
  owner_user_id?: string | null;
  owned_by_me?: boolean;
  // Unacknowledged handoff: a teammate assigned this session to the current user
  // and they haven't acked it yet (session_owners.seen_at unset). Stamped by
  // computeInboxSessions; cleared by ackSessionAssignment (server) and
  // clearAssignedPing (local-first).
  assigned_ping?: { by_name: string; note?: string | null; at: number } | null;
  // An Anchor's session renders under its bot identity (acting_user_id), shown
  // even on the host's own row; is_anchor marks it a standing member.
  acting_user_id?: string | null;
  is_anchor?: boolean;
  persistent?: boolean;
  anchor_id?: string | null;
};

// An image attached to an outbound (optimistic) message. While its upload is in
// flight it carries a local `preview_url` (blob:) + `uploading: true` so the
// pending bubble can show a thumbnail + spinner; once uploaded it carries the
// real `storage_id` and the spinner clears.
export type OptimisticImage = {
  media_type: string;
  storage_id?: string;
  preview_url?: string;
  uploading?: boolean;
};

export type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: any[];
  tool_results?: any[];
  images?: any[];
  subtype?: string;
  _isOptimistic?: true;
  _isQueued?: true;
  _clientId?: string;
  _isFailed?: true;
  // The exact content the durable send dispatched for this row (mention
  // expansion appends context the bubble's raw `content` doesn't have). The
  // server fingerprints command args by client id, so every redrive/resend must
  // replay these bytes — rebuilding from `content` makes the server refuse the
  // replay as COMMAND_ID_REUSED and falsely fail an already-delivered message.
  _dispatchContent?: string;
  client_id?: string;
  // The conversation's server-stamped `updated_at` at the instant this optimistic
  // send was added. The server bumps `updated_at` when it accepts the send, so a
  // later snapshot whose `updated_at` exceeds this baseline proves the server has
  // processed our message — the only safe moment to let the absence-based prune
  // (is_idle && !has_pending) drop the pending pill. Without it a stale pre-send
  // snapshot prunes a just-sent message and flickers the card out of Working.
  _sentBaselineTs?: number;
};

// The complete, non-paginated set of navigable (user + assistant) messages for
// a conversation, fetched once via getUserMessages and cached so the sticky
// header and message browser have the full list regardless of which window of
// messages is currently paginated in.
export type UserMessage = {
  _id: string;
  message_uuid?: string;
  role: "user";
  content: string;
  timestamp: number;
};

export type PaginationState = {
  lastTimestamp: number | null;
  oldestTimestamp: number | null;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
  loadOlderTimestamp?: number;
  loadNewerTimestamp?: number;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  jumpMode: "start" | "end" | null;
  loadedStartIndex: number;
  isSearchingForTarget: boolean;
  initialized: boolean;
};

export type ConversationMeta = Record<string, any>;

export type ForkChild = {
  _id: string;
  user_id?: string;
  title: string;
  short_id?: string;
  started_at?: number;
  username?: string;
  parent_message_uuid?: string;
  message_count?: number;
  agent_type?: string;
  // Enriches the BranchSelector chip + hover; all free off the conversation row
  // (see mapForkDetails). fork_copied = messages inherited from the parent up to
  // the fork point, so message_count - fork_copied is this branch's own size.
  updated_at?: number;
  last_message_preview?: string;
  last_message_role?: string;
  last_user_message_at?: number;
  status?: string;
  git_branch?: string;
  fork_copied?: number;
  // First user prompt past the fork point — the divergent message that
  // distinguishes this branch from its siblings (see mapForkDetails).
  first_divergent_preview?: string;
  // Triage/visibility state off the same conversation row. preloadForkSessions
  // copies these onto the seeded row so a stashed/dismissed/killed branch never
  // masquerades as an active needs-input card at boot.
  forked_from?: string | null;
  project_path?: string;
  git_root?: string;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_killed_at?: number | null;
  inbox_pinned_at?: number | null;
};

// The loose conversation-summary shape every cache-seeding surface maps its
// server payload into: fork preloads (ForkChild), the ?s= deep-link inject
// (getConversation), the palette inject (performListRecentSessions rows and
// favorite store rows), and task/doc/workflow linked-session opens
// (taskMining snapshots). All of them seed `store.sessions` from data narrower
// than a synced row, so they share ONE constructor below instead of each
// hand-picking fields — hand-picked shapes are how stashed sessions seeded as
// active cards and flashed into the inbox at boot (ct-42666).
export type SessionSummary = {
  _id: string;
  session_id?: string;
  title?: string;
  updated_at?: number;
  started_at?: number;
  agent_type?: string | null;
  message_count?: number;
  is_idle?: boolean;
  project_path?: string | null;
  git_root?: string | null;
  forked_from?: string | null;
  parent_message_uuid?: string | null;
  parent_conversation_id?: string | null;
  user_id?: string;
  author_name?: string | null;
  author_avatar?: string | null;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  inbox_killed_at?: number | null;
  inbox_pinned_at?: number | null;
};

const SUMMARY_PASSTHROUGH_KEYS = [
  "project_path",
  "git_root",
  "forked_from",
  "parent_message_uuid",
  "parent_conversation_id",
  "user_id",
  "author_name",
  "author_avatar",
] as const;

export const TRIAGE_STAMP_KEYS = [
  "inbox_dismissed_at",
  "inbox_stashed_at",
  "inbox_killed_at",
  "inbox_pinned_at",
] as const;

// Build a session cache row from a server summary. The one rule that makes
// this sound: a key the payload does not carry stays ABSENT on the row —
// never defaulted. The inbox categorizer cannot tell "field missing" from
// "field false", so fabricating `inbox_stashed_at: null` from a projection
// that simply omitted the field would un-hide a triaged session; leaving it
// absent lets a later, richer payload (or preloadForkSessions' heal pass)
// fill it. Keys the payload DOES carry are copied even when null — an
// explicit null is a real "not stashed". Unknown extra keys on the summary
// are dropped (whitelist), so a caller spreading a fat server object can't
// smuggle a new field shape past this contract.
export function sessionRowFromSummary(summary: SessionSummary): InboxSession {
  const row = {
    _id: summary._id,
    session_id: summary.session_id || summary._id,
    title: summary.title,
    updated_at: summary.updated_at ?? summary.started_at ?? Date.now(),
    started_at: summary.started_at,
    agent_type: summary.agent_type || "claude_code",
    message_count: summary.message_count ?? 0,
    is_idle: summary.is_idle ?? true,
    has_pending: false,
  } as InboxSession;
  for (const k of SUMMARY_PASSTHROUGH_KEYS) {
    if (summary[k] !== undefined) (row as any)[k] = summary[k];
  }
  for (const k of TRIAGE_STAMP_KEYS) {
    if (summary[k] !== undefined) (row as any)[k] = summary[k] ?? null;
  }
  // The buckets read the enriched twin, so derive it the way the server does —
  // but only when the stamp was actually delivered.
  if (summary.inbox_pinned_at !== undefined) row.is_pinned = !!summary.inbox_pinned_at;
  return row;
}

export type CurrentConversationContext = {
  conversationId?: string;
  projectPath?: string;
  gitRoot?: string;
  agentType?: string;
  source?: "inbox" | "sessions";
};

// -- Task / Doc Types --

export type TaskStep = {
  title: string;
  done?: boolean;
  verification?: string;
};

export type TaskExecutionStatus = "done" | "done_with_concerns" | "blocked" | "needs_context";

export type TaskItem = {
  _id: string;
  short_id: string;
  title: string;
  description?: string;
  task_type: string;
  status: string;
  priority: string;
  source: string;
  triage_status?: string;
  // True = on the human's board: set by triage promote or `cast task create
  // --human`. Machine-created tasks without it are agent-internal.
  promoted?: boolean;
  // Idempotency key on optimistic create-stubs; altKey-supersedes to the real row.
  client_key?: string;
  // Subtask edge: the task this one is filed under. Always a task in the SAME
  // workspace (convex resolveParentTask enforces that), so nesting can never
  // pull a row across the workspace boundary the views scope by.
  parent_id?: string | null;
  // Manual list rank; unranked rows fall back to created_at (same ms scale).
  sort_order?: number;
  // Short id of the canonical task this one duplicates (set with drop status).
  duplicate_of?: string;
  labels?: string[];
  blocked_by?: string[];
  blocks?: string[];
  user_id?: string;
  assignee?: string;
  assignee_info?: { name: string; image?: string } | null;
  confidence?: number;
  created_at: number;
  updated_at: number;
  closed_at?: number;
  creator?: { name: string; image?: string };
  plan?: PlanRef;
  activeSession?: { session_id: string; title?: string; agent_status?: string; agent_type?: string } | null;
  source_agent_type?: string | null;
  origin_session?: { conversation_id: string; session_id: string; title?: string; started_by?: string; last_message_at?: number; message_count?: number } | null;
  session_count?: number;
  created_from_conversation?: string;
  conversation_ids?: string[];
  steps?: TaskStep[];
  acceptance_criteria?: string[];
  execution_status?: TaskExecutionStatus;
  execution_concerns?: string;
  verification_evidence?: string;
  files_changed?: string[];
  estimated_minutes?: number;
  actual_minutes?: number;
  started_at?: number;
  team_id?: string;
  // ACCESS key ("team:<id>" | "user:<id>"), server-stamped; independent of
  // team_id (routing). Views filter on it via lib/workspaceScope.
  workspace?: string;
  workflow_run_id?: string;
  workflow_node_id?: string;
  project_path?: string;
};

// Manual session buckets: personal named groups for filing inbox sessions by
// workstream (chips in the session panel header + a "by bucket" grouping mode).
export type BucketItem = {
  _id: string;
  user_id?: string;
  name: string;
  color?: string;
  sort_order?: number;
  archived_at?: number;
  created_at: number;
  updated_at: number;
};

// One row per (user, conversation); bucket_id null/undefined = unfiled.
export type BucketAssignmentItem = {
  _id: string;
  user_id?: string;
  conversation_id: string;
  bucket_id?: string | null;
  updated_at: number;
};

// The decision queue: one explicit question an agent handed its human via
// `cast decide` (session_decisions table). Answering is local-first — the
// resolution fields flip on the draft and ride the generic patch rail; the
// chosen option separately enters the session as a normal user message.
/** One binding row as webListBindings returns it. Optimistic stubs carry a
 *  client_key as _id until the server row supersedes them. */
export interface CapabilityBindingRow {
  _id: string;
  user_id?: string;
  team_id?: string;
  capability_slug: string;
  scope_kind: string;
  scope_key: string;
  enabled: boolean;
  config?: Record<string, string>;
  client_filter?: string[];
  min_client_version?: string;
  client_key?: string;
  created_by?: string;
  updated_at: number;
}

export type SessionDecisionItem = {
  _id: string;
  conversation_id: string;
  session_id: string;
  user_id?: string;
  question: string;
  context_md?: string;
  options: Array<{ label: string; description?: string }>;
  report_slug?: string;
  blocking: boolean;
  default_option?: number;
  // withdrawn: the agent took its question back (`cast decide cancel`).
  status: "pending" | "answered" | "dismissed" | "withdrawn";
  answer_index?: number;
  answer_text?: string;
  created_at: number;
  // conversation.message_count at ask time; live count minus this is
  // "messages since the ask", correct beyond the loaded window.
  asked_message_count?: number;
  // Last `cast decide edit`; created_at is the ask time (queue age).
  updated_at?: number;
  resolved_at?: number;
};

// conversation_id → bucket_id lookup, derived at read time from the assignment
// rows (never stored — see the liveEntities rule on derived snapshots).
export function convBucketMap(assignments: Record<string, BucketAssignmentItem>): Record<string, string | undefined> {
  // A conversation can transiently carry two rows: the optimistic
  // `bucketassign-` stub (immortal on disk — the cache never deletes without an
  // exclude — so hydration unions it back each boot until live sync rekeys it)
  // and the real server row. Real rows beat stubs, then newer beats older, so
  // a stale stub can never shadow a later re-bucketing.
  const winner: Record<string, BucketAssignmentItem> = {};
  for (const a of Object.values(assignments)) {
    const prev = winner[a.conversation_id];
    if (prev) {
      const realness = Number(isConvexId(a._id)) - Number(isConvexId(prev._id));
      if (realness < 0 || (realness === 0 && (a.updated_at ?? 0) <= (prev.updated_at ?? 0))) continue;
    }
    winner[a.conversation_id] = a;
  }
  const map: Record<string, string | undefined> = {};
  for (const a of Object.values(winner)) map[a.conversation_id] = a.bucket_id ?? undefined;
  return map;
}

// Close the open subtree under a parent in the draft — the optimistic mirror
// of the server's cascadeClose, so a "close subtasks too" choice renders
// instantly. Statuses are raw fields and reconcile cleanly with the echo.
function cascadeCloseDraft(draft: { tasks: Record<string, TaskItem> }, parentId: string, status: string) {
  const all = Object.values(draft.tasks) as any[];
  const queue = [String(parentId)];
  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const cur = queue.shift()!;
    for (const t of all) {
      if (!t.parent_id || String(t.parent_id) !== cur) continue;
      queue.push(String(t._id));
      // Only stamp `status` — the render reads status alone. A locally-stamped
      // closed_at/updated_at would become a pending field lock the server's own
      // timestamp never echoes, and a frozen updated_at drops later delta pushes
      // (it is the collection version key). The server sets those on echo.
      if (t.status !== "done" && t.status !== "dropped") t.status = status;
    }
  }
}

export type TaskDetail = TaskItem & {
  comments?: any[];
  linked_conversations?: any[];
  related_docs?: any[];
  source_insight?: any;
  creator?: { _id: string; name: string; image?: string };
  history?: any[];
  created_from_conversation?: string;
  plan?: PlanRef;
};

export type DocItem = {
  _id: string;
  title: string;
  content: string;
  doc_type: string;
  source: string;
  source_file?: string;
  // Workspace: set = that team's doc, unset = personal. The server ships the
  // EFFECTIVE team here (conversation-derived — convex data.ts
  // stampEffectiveTeam), so views filter on it directly (lib/workspaceScope).
  team_id?: string;
  // ACCESS key ("team:<id>" | "user:<id>"), server-stamped; independent of
  // team_id (routing). Views filter on it via lib/workspaceScope.
  workspace?: string;
  labels?: string[];
  pinned?: boolean;
  plan_id?: string;
  plan_short_id?: string;
  plan_status?: string;
  parent_id?: string | null;
  sort_order?: number;
  linked_doc_ids?: string[];
  created_at: number;
  updated_at: number;
};

export type DocDetail = DocItem & {
  conversation?: any;
  related_tasks?: any[];
  related_sessions?: any[];
  // Last time this client opened (or body-prefetched) the doc — drives the
  // persisted docDetails cache's LRU retention (partitionDocDetailRetention).
  _cachedAt?: number;
};

export type TaskViewPrefs = {
  status?: string;
  statuses?: string;
  view?: "list" | "kanban";
  group?: string;
  sort?: string;
  dir?: string;
  priority?: string;
  label?: string;
  assignee?: string;
  session?: string;
  project?: string;
  hide_agent?: boolean;
  source?: string;
  /** Kanban column order (status ids), set by dragging column headers. */
  kanban_order?: string[];
};

export type DocViewPrefs = {
  doc_type?: string;
  group?: string;
  sort?: string;
  dir?: string;
  project?: string;
  label?: string;
  source?: string;
  scope?: string;
};

export type PlanViewPrefs = {
  source?: string;
};

export type SavedView = {
  id: string;
  name: string;
  page: "tasks" | "docs" | "plans";
  prefs: TaskViewPrefs | DocViewPrefs | PlanViewPrefs;
  team_id?: string;
  created_at: number;
};

/**
 * A saved view as it now lives on the server (convex/savedViews.ts). The legacy
 * SavedView above is the client_state shape these were kept in before they could
 * be shared; useSyncSavedViews migrates those across once and then they are gone.
 */
export type SavedViewRow = {
  _id: string;
  client_key?: string;
  user_id?: string;
  team_id?: string;
  name: string;
  // "workspace" = a layout workbench: the saved arrangement of the chrome
  // itself (store/workbench.ts), riding the same rows as the list views.
  page: "tasks" | "docs" | "plans" | "workspace";
  prefs: TaskViewPrefs | DocViewPrefs | PlanViewPrefs | WorkbenchSnapshot;
  /** Visible to the whole team's rail, not just its author's. */
  shared?: boolean;
  icon?: string;
  color?: string;
  /** Enrichment from webList — who authored a view you did not. */
  owner_name?: string;
  owner_image?: string;
  is_mine?: boolean;
  created_at: number;
  updated_at: number;
};

// The inbox panel's session-ordering modes. "grouped" = status sections;
// "recent" = flat, newest-first by last activity (updated_at) — reshuffles as
// sessions work; "time" = flat, newest-first by creation (started_at) — a
// stable chronology that doesn't move; "bucket" = sections per manual label;
// "plan" = sections per plan; "trigger" = trigger-first — every armed trigger
// (and loop/subagent) is a group header with the sessions it drives beneath.
export type InboxViewMode = "grouped" | "recent" | "time" | "bucket" | "plan" | "trigger";


export type ClientUI = {
  theme?: "light" | "dark";
  sidebar_collapsed?: boolean;
  zen_mode?: boolean;
  sticky_headers_disabled?: boolean;
  diff_panel_open?: boolean;
  file_diff_view_mode?: "unified" | "split";
  active_team_id?: string;
  active_filter?: "my" | "team";
  inbox_shortcuts_hidden?: boolean;
  // Session-event sounds (a session finishing, going idle, being killed).
  sounds_enabled?: boolean;
  // Chat toast sounds, split from the above: an agent fleet's chirps and a
  // teammate speaking are different interruptions, and people who mute one
  // usually still want the other. Absent = on, same as sounds_enabled.
  chat_sounds_enabled?: boolean;
  // Chat toasts stay quiet until this instant. Set from the snooze button on a
  // toast — the off switch has to be one gesture from the annoyance, or people
  // mute everything after one bad afternoon.
  chat_snooze_until?: number;
  task_view?: TaskViewPrefs;
  doc_view?: DocViewPrefs;
  plan_view?: PlanViewPrefs;
  saved_views?: SavedView[];
  show_subagents?: boolean;
  // Trigger rows under inbox cards: expanded (full row per trigger — name,
  // last report, countdown, verbs) or folded to a one-line strip that only says
  // the card has triggers and when the next one fires. Absent = folded: the
  // strip is the resting state; the pill toggle opens the detail.
  // LEGACY — superseded by card_bars; still read as the default when card_bars
  // is unset so an existing "expanded" choice survives the upgrade.
  show_triggers?: boolean;
  // The bars under inbox cards — triggers, workflow runs, monitors and
  // background commands — as one family with one control: "strip" folds each
  // card's bars to a one-line summary (the resting state), "full" shows every
  // bar as its own row, "hidden" removes them entirely (the same gesture the
  // subagent toggle offers). Absent = show_triggers legacy, then "strip".
  card_bars?: "strip" | "full" | "hidden";
  // The machine you last chose by hand in the new-session picker — the default
  // the picker opens on for NEW work (defaultMachineId rung 2). Deliberately
  // UNSTAMPED, i.e. per-device: "where should this run" is answered differently
  // from a phone than from the laptop that holds the checkouts.
  last_picked_device_id?: string;
  // User-set height (px) of the trigger full-prompt viewport (TriggerPromptView
  // drag handle). Layout pref → unstamped, per-device local_wins.
  trigger_prompt_height?: number;
  // "Show old sessions" — reveal cached rows the live (authoritative) inbox
  // subscription no longer returns. Default hide. Successor to the removed
  // show_old_sessions key, whose blanket-local_wins sync made one browse click
  // a permanent all-clients cruft mode (the OFF could never propagate, and a
  // stale server `true` was unkillable). This key is stamped LWW (see
  // STAMPED_UI_KEYS): the newest toggle on ANY device wins everywhere —
  // including off — so sticky can't decay into stuck. The legacy key still
  // lingers in server docs; nothing may ever read it (resolveShowOld).
  inbox_show_old?: boolean;
  // Inbox scope. "mine" (default) is the personal inbox: your own sessions plus
  // any explicitly routed to you. "team" turns the inbox into a shared board of
  // every team-visible session across the active team (a superset of "mine").
  // Stamped LWW so the chosen scope survives reloads and follows the user.
  inbox_scope?: "mine" | "team";
  // Show each session's model as a badge in the inbox list. Off by default.
  show_model_badge?: boolean;
  // Show each session's agent client icon (Claude Code, opencode, …) next to
  // its title in the inbox list. On by default; read as `!== false`.
  show_agent_icon?: boolean;
  // Opt in to the teammate-comment tools (the gutter "comment" handle + the
  // header toggle when a conversation has none yet). Off by default — you still
  // SEE and can reply to comments others leave regardless of this.
  comments_enabled?: boolean;
  // Suggested replies above the composer ("suggestion pills"), predicted by a
  // small model from the session tail plus the user's own frequent past
  // inputs. Off by default; stamped LWW — a behavior pref that follows the
  // user, not the device.
  composer_suggestions?: boolean;
  // The composer's mic has been explained once, so it never explains itself
  // again. A hold is not a click, and a small round key cannot say so on its own
  // — the first DM composer that offers push to talk floats a small callout
  // over it, and this retires that callout for good. Stamped LWW: learning the
  // gesture on the laptop means the phone's browser has learned it too.
  walkie_hold_seen?: boolean;
  // Which view the people window shows: the wall of faces (default) or the
  // roster list. Unstamped, so it stays a per-device reading preference like
  // the sidebar and zen mode — the window is a different size on every machine,
  // and which view fits is a fact about the window, not about the person.
  people_view?: "wall" | "list";
  // Which microphone and camera a deliberate join opens (lib/calls/joinPrefs).
  // Unstamped on purpose: a device id names hardware attached to THIS machine,
  // so the newest choice must not travel — the laptop's headset id is noise on
  // the desktop, and switchActiveDevice would simply fail on it.
  call_mic_device_id?: string;
  call_camera_device_id?: string;
  // Whether a deliberate join turns the camera on. Stamped LWW, because this
  // one IS about the person: somebody who joins with video joins with video
  // wherever they are signed in.
  call_camera_on?: boolean;
  // Fold the pinned thread-state panel above the composer down to its headline
  // row. Expanded by default — the panel exists to be read on arrival — and
  // left unstamped, so it stays a per-device reading preference like the other
  // layout toggles.
  thread_state_collapsed?: boolean;
  // Inbox session panel view mode. When true, the panel drops the
  // Pinned/New/Needs-Input/Working grouping and shows every session as one flat
  // list sorted newest-first by creation time (started_at). Toggled by Ctrl+,.
  inbox_flat_view?: boolean;
  // Successor to inbox_flat_view: see InboxViewMode. The legacy boolean is kept
  // coherent (true for either flat mode) so older readers still flatten. Ctrl+, cycles.
  inbox_view_mode?: InboxViewMode;
  // Per-user manual order for the "time" view: a SPARSE map of conversation id →
  // sort key, where the key lives in the SAME epoch-ms space as started_at. Rows
  // absent from the map fall back to their creation time, so un-dragged rows and
  // brand-new sessions interleave by creation automatically; a drag pins just the
  // moved row with a single midpoint write. See flatViewComparator / computeManualSortKey.
  inbox_manual_order?: Record<string, number>;
  // Read watermark for the TRIGGERS section: outcomes with last_run_at newer
  // than this count as "N new" on the collapsed header. Refreshed whenever the
  // user toggles the section (expanding IS reading the briefing).
  schedules_seen_at?: number;
  // Sidebar subsection rows pinned to the top of the rail (lib/sidebarPins).
  // Structural shape rather than the SidebarPin import: sidebarPins.ts imports
  // this store, and a type import back the other way invites a require cycle.
  sidebar_pins?: Array<{ kind: "project" | "view" | "channel"; id: string; label: string }>;
  // The Threads page's "include agent sessions" toggle. Off unless exactly
  // true. Stamped (STAMPED_UI_KEYS): a per-user view preference.
  threads_include_sessions?: boolean;
  // The workspace arrangement (see store/workspace.ts): which slots are open,
  // peek vs split, and their sizes. Subject-bearing panes are deliberately NOT
  // persisted — the arrangement is worth remembering, its contents are
  // re-derived from where you are now.
  workspace?: PersistedWorkspace;
  // Simple view: calm, low-chrome rendering of conversations and inbox cards —
  // secondary badges, counts and meta rows drop away. A per-user preference
  // ("my reading style follows me") → stamped LWW.
  simple_view?: boolean;
  // Show a small thumbnail on inbox session rows when the session contains
  // images (session.image_preview_url). Independent of simple_view — applies
  // in both. Off by default; per-user preference → stamped LWW.
  inbox_image_thumbs?: boolean;
  // What the inbox opens on when no conversation is selected: the fleet board
  // (a live band-grouped tile grid of every session) or the chronological
  // activity feed. Board is the default. Per-user → stamped LWW.
  inbox_home?: "board" | "feed";
};

export type ClientLayouts = {
  dashboard?: { sidebar: number; main: number };
  inbox?: { main: number; sidebar: number };
  conversation_diff?: { content: number; diff: number };
  file_diff?: { tree: number; content: number };
};

export type ClientDismissed = {
  desktop_app?: boolean;
  has_used_desktop?: boolean;
  // User chose "stay in browser" from the open-in-desktop hand-off; suppresses
  // the auto-redirect from then on (synced per-user across browsers).
  prefer_browser_links?: boolean;
  setup_prompt?: number;
  cli_offline?: number;
  tmux_missing?: number;
  team_sharing_prompt?: number;
  // Blocked-sessions banner X (timestamp snooze, cross-device).
  blocked_sessions_banner?: number;
  // "Turn on desktop notifications" nudge X (timestamp snooze; a missed
  // message overrides it — lib/notificationNudge.ts).
  notif_nudge?: number;
  // "Set up account switching" promo inside that banner — permanent opt-out.
  cc_accounts_promo?: boolean;
  // "New agent features" upsell — one stamp per snippet slug the user enabled
  // or dismissed from the intro (timestamp; cross-device via per-key LWW).
  [k: `snippet_intro_${string}`]: number | undefined;
};

export type ClientTips = {
  seen?: string[];
  dismissed?: string[];
  completed?: string[];
  level?: 'all' | 'subtle' | 'none';
  _inlineSuppressed?: boolean;
};

// A tab freezes its WHOLE view, frame included. Content identity (path,
// session) says what the stage shows; `workspace` carries the panel
// arrangement — left nav, list, right rail, dock: each slot's pane,
// presentation and size — exactly as the tab last showed it. Switching away
// stamps the live arrangement onto the tab; switching back restores it, the
// same way the tab restores its columns and scroll. A tab with no snapshot
// yet (a fresh tab) inherits the frame it was opened under.
export type AppTab = {
  id: string;
  title: string;
  path: string;
  sessionId?: string;
  createdAt: number;
  /** The full panel arrangement as of the last switch away from this tab. */
  workspace?: WorkspaceState;
  /** The right rail's conversation at stamp time (sidePanelSessionId). */
  railSessionId?: string | null;
};

// The path to stamp onto a tab from the live browser URL when switching away.
// Includes the query string so a tab's deep-link (`/inbox?s=<id>`) survives a
// switch — stamping only `pathname` was silently dropping it.
//
// Crucial detail: the inbox canonicalizes its URL to `/conversation/<id>` while a
// session is open, but an inbox tab must STAY on the inbox route — otherwise its
// pane re-matches the standalone `<Conversation>` component on the next show,
// unmounting the whole subtree (and the scroll position with it). So an inbox tab
// whose live URL is a `/conversation/<id>` keeps the equivalent `/inbox?s=<id>`.
export function stampedTabPath(tab: AppTab): string {
  // React Native defines `window` but not `window.location`, so guard on the
  // actual API (a bare `typeof window` check sails through and then throws).
  if (typeof window === "undefined" || !window.location) return tab.path;
  const live = window.location.pathname + window.location.search;
  const conv = window.location.pathname.match(/^\/conversation\/([^/?#]+)$/);
  if (conv && tab.path.split("?")[0] === "/inbox") return `/inbox?s=${conv[1]}`;
  // A live URL outside the shell (the app root during boot, a marketing page,
  // the palette window) is not this tab's content: keep what the tab held, or
  // the stamp pins the tab to a path the shell cannot render (lib/tabRoutes).
  if (isNonTabRoute(window.location.pathname)) return tab.path;
  return live;
}

// Stamp the active tab with everything a later switch back must restore: its
// live path, the panel arrangement, and the right rail's conversation.
function stampActiveTab(draft: { activeTabId: string | null; tabs: AppTab[]; workspace: WorkspaceState; sidePanelSessionId: string | null }, patch?: Partial<AppTab>) {
  if (!draft.activeTabId) return;
  draft.tabs = draft.tabs.map((t: AppTab) => t.id === draft.activeTabId ? {
    ...t,
    path: stampedTabPath(t),
    workspace: draft.workspace,
    railSessionId: draft.sidePanelSessionId,
    ...patch,
  } : t);
}

// The other half of the freeze: put a tab's stamped frame back on screen.
// Adoption is slot-validated (adoptWorkspaceSnapshot) so a legacy or partial
// snapshot can never leave the workspace missing a slot, and the persistence
// mirror is refreshed so a reload paints the frame that is actually visible.
function restoreTabWorkspace(draft: any, tab: AppTab | undefined) {
  if (!tab) return;
  const next = adoptWorkspaceSnapshot(draft.workspace as WorkspaceState, tab.workspace);
  if (next !== draft.workspace) {
    draft.workspace = next;
    persistWorkspace(draft);
  }
  if (tab.railSessionId !== undefined && tab.railSessionId !== draft.sidePanelSessionId) {
    draft.sidePanelSessionId = tab.railSessionId;
  }
}

export type ClientState = {
  current_conversation_id?: string;
  dismissed_ids?: string[];

  ui?: ClientUI;
  layouts?: ClientLayouts;
  dismissed?: ClientDismissed;
  tips?: ClientTips;
  drafts?: Record<string, Record<string, any> | null>;
  tabs?: AppTab[];
  activeTabId?: string;

  // deprecated: backward compat
  sidebar_collapsed?: boolean;
  zen_mode?: boolean;
  layout?: { sidebar: number; main: number };
};

type Draft = InboxStoreState;

// -- Helpers --

export function isSessionDismissed(s: Pick<InboxSession, "inbox_dismissed_at">): boolean {
  return !!s.inbox_dismissed_at;
}

// Retired: the agent was torn down. A distinct field from inbox_dismissed_at,
// not a synonym. Most kills write both — a hide patch carries
// inbox_dismissed_at and applyHideTransition stamps the marker on top, which
// covers the web's kill action AND `cast kill` (cliSetSessionVisibility patches
// inbox_dismissed_at, then forces the kill transition). The exception is the
// killSession MUTATION (conversations.ts), which stamps inbox_killed_at ALONE:
// that's the path behind the web's convCommand("killSession") — the /sessions
// kill button and the panel's kill-and-complete. Anything asking "is this
// killed?" must read this field or it silently misses those.
export function isSessionKilled(s: Pick<InboxSession, "inbox_killed_at">): boolean {
  return !!s.inbox_killed_at;
}

export function isSessionStashed(
  s: Pick<InboxSession, "inbox_dismissed_at" | "inbox_stashed_at">,
): boolean {
  // Dismiss wins: a stashed session that later gets dismissed renders in the
  // Dismissed bucket, never both.
  return !!s.inbox_stashed_at && !s.inbox_dismissed_at;
}

// Out of the active inbox buckets for either reason (dismissed or stashed).
// Hidden sessions are viewed through the peek path (viewingDismissedId) so
// navigation never silently resurrects them.
export function isSessionHidden(
  s: Pick<InboxSession, "inbox_dismissed_at" | "inbox_stashed_at">,
): boolean {
  return !!s.inbox_dismissed_at || !!s.inbox_stashed_at;
}

// "Old" = a top-level session the LIVE inbox subscription (show_all:false) no
// longer returns, yet the never-prune cache still holds because the completeness
// crawl backfilled it. The "show old sessions" toggle filters these out locally
// — no server re-fetch — so it's instant and never spins the sync chip. Never
// treat as old: optimistic stubs (no Convex id yet), subagents (they ride their
// parent), pinned/focused rows, or dismissed/stashed rows (their own buckets).
// An agent-team teammate rides its LEAD's liveness instead: while the lead is
// in the live window the teammate stays (nested under it), but unlike a Task
// subagent it isn't exempt outright — a teammate from a dead team ages out
// like any session rather than haunting the inbox forever.
export function isOldSession(
  s: InboxSession,
  liveInboxIds: Set<string>,
  focusedId?: string | null,
): boolean {
  const nestParent = !s.parent_conversation_id ? nestParentIdOf(s) : null;
  return (
    isConvexId(s._id) &&
    !s.parent_conversation_id &&
    !s.is_pinned &&
    !isSessionHidden(s) &&
    s._id !== focusedId &&
    !liveInboxIds.has(s._id) &&
    !(nestParent && liveInboxIds.has(nestParent))
  );
}

// Split the cache into the rows the inbox should render and a count of the "old"
// rows hidden. liveInboxIds is empty until the first live payload lands — treat
// that as "nothing is old yet" so a cold open never blanks the list. With
// showAll, keep everything but still report the count (drives the toggle badge).
export function partitionOldSessions(
  sessions: Record<string, InboxSession>,
  liveInboxIds: Set<string>,
  showAll: boolean,
  focusedId?: string | null,
): { visibleSessions: Record<string, InboxSession>; oldCount: number } {
  if (liveInboxIds.size === 0) return { visibleSessions: sessions, oldCount: 0 };
  // Single pass: count the old rows and collect the visible ones at once. This
  // runs on every liveness heartbeat over the whole (never-pruned) session map,
  // so the previous two-pass version doubled that cost for no reason. When there
  // are no old rows / showAll is on we return the original `sessions` ref (not the
  // rebuilt copy) to keep downstream memos referentially stable.
  let oldCount = 0;
  const visibleSessions: Record<string, InboxSession> = {};
  for (const [id, sess] of Object.entries(sessions)) {
    if (isOldSession(sess, liveInboxIds, focusedId)) oldCount++;
    else visibleSessions[id] = sess;
  }
  if (showAll || oldCount === 0) return { visibleSessions: sessions, oldCount };
  return { visibleSessions, oldCount };
}

// Is this cached row definitively someone ELSE's session — i.e. not the caller's
// to see in the personal inbox? A row is "mine" if it's my own authored session,
// one routed to me to steer (owner), an optimistic stub not yet server-keyed, or
// a thin row with no known author. Everything else is a teammate's row that only
// entered the shared cache via team mode / a deep-link / search, and must not
// linger in "mine".
function isForeignRow(s: InboxSession, meId: string | null | undefined): boolean {
  if (!meId) return false; // unknown viewer → don't hide anything
  if (!isConvexId(s._id)) return false; // optimistic stub — always mine
  if (!s.user_id) return false; // thin/legacy row with no author → keep
  return isForeignSession(s, undefined, meId);
}

// Scope the never-prune sessions cache to the current inbox scope BEFORE the
// old-session partition runs. This is what makes "mine" and "team" coherent even
// though both read the same shared cache:
//   • "mine": drop rows that are definitively a teammate's, so team-mode rows (or
//     a teammate session opened via deep-link/search) never leak into the
//     personal inbox — regardless of the show-old toggle.
//   • "team": keep exactly the rows the team subscription reported (teamInboxIds),
//     plus the open session and any optimistic stub. Before the first team payload
//     lands (empty set) fall back to the mine filter so the board shows your own
//     work immediately instead of flashing empty.
// The focused row is always kept so the session you're viewing never vanishes.
const EMPTY_TEAM_INBOX_IDS: ReadonlySet<string> = new Set<string>();

export function filterInboxScope(
  sessions: Record<string, InboxSession>,
  scope: "mine" | "team",
  meId: string | null | undefined,
  teamInboxIds: ReadonlySet<string> = EMPTY_TEAM_INBOX_IDS,
  focusedId?: string | null,
): Record<string, InboxSession> {
  if (scope === "team" && teamInboxIds.size > 0) {
    const out: Record<string, InboxSession> = {};
    for (const [id, s] of Object.entries(sessions)) {
      if (teamInboxIds.has(id) || id === focusedId || !isConvexId(id)) out[id] = s;
    }
    return out;
  }
  // "mine" (and team before its first payload): hide definitively-foreign rows.
  let anyForeign = false;
  for (const s of Object.values(sessions)) {
    if (s._id !== focusedId && isForeignRow(s, meId)) { anyForeign = true; break; }
  }
  if (!anyForeign) return sessions; // referentially stable when nothing to drop
  const out: Record<string, InboxSession> = {};
  for (const [id, s] of Object.entries(sessions)) {
    if (id === focusedId || !isForeignRow(s, meId)) out[id] = s;
  }
  return out;
}

// filterInboxScope with its canonical arguments read off a store snapshot — the
// one call every session picker / MRU list makes before enumerating the shared
// cache. The cache holds rows from other scopes and previously viewed teams, so
// any raw Object.values(sessions) surface leaks them.
export function filterInboxScopeFromState(st: {
  sessions: Record<string, InboxSession>;
  clientState: { ui?: { inbox_scope?: "mine" | "team" } };
  currentUser?: { _id: unknown } | null;
  teamInboxIds: ReadonlySet<string>;
  currentSessionId: string | null;
}): Record<string, InboxSession> {
  return filterInboxScope(
    st.sessions,
    st.clientState.ui?.inbox_scope ?? "mine",
    st.currentUser?._id?.toString?.() ?? null,
    st.teamInboxIds,
    st.currentSessionId,
  );
}

// Window the cross-device dismiss reconcile is authoritative over. Mirrors the
// server's INBOX_DISMISSED_WINDOW_MS (the range listDismissedSessionsLite scans):
// the server only reports dismisses within this window, so the client can only
// infer an un-dismiss (CLEAR) for a locally-dismissed session whose timestamp
// falls inside it — older ones may still be dismissed server-side, just out of
// scan range. Keep in sync with packages/convex/convex/conversations.ts.
export const DISMISS_RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Ordering precedence for a session, lowest-rank-first. Computed ONCE per
// session so the comparator is a cheap tuple compare instead of re-deriving the
// classification on every comparison. Each entry mirrors a tier of the old
// short-circuit comparator exactly (pinned → not-deferred → stub-id →
// new → waiting-for-input → idle), so the resulting order is identical.
const REST_RANK: Record<SessionRestState, number> = { needs_input: 0, done: 1, dormant: 2 };
function sessionSortRank(s: InboxSession): [number, number, number, number, number, number, number] {
  const c = classifySession(s);
  return [
    s.is_pinned ? 0 : 1,                              // pinned first
    s.is_deferred ? 1 : 0,                            // deferred last
    isConvexId(s._id) ? 1 : 0,                        // optimistic stub ids first
    (s.message_count ?? 0) === 0 ? 0 : 1,            // brand-new (no messages) first
    c.waiting ? 0 : 1,                                // needs-input first
    // Among settled rows: blocked → delivered → parked. Also what wakes the
    // sidebar when a row moves between the three rest sections (the wake
    // signature folds this rank in).
    c.waiting ? REST_RANK[c.rest] : 0,
    c.idle ? 0 : 1,                                   // idle before active
  ];
}

// A session paired with its precomputed sort rank.
type RankedSession = { s: InboxSession; rank: ReturnType<typeof sessionSortRank> };

// Comparator over precomputed ranks, with _id as the stable tiebreak. Defined
// once and shared by sortSessions and categorizeSessions so the active-session
// order lives in exactly one place.
function compareRankedSessions(a: RankedSession, b: RankedSession): number {
  for (let i = 0; i < a.rank.length; i++) {
    if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  }
  return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
}

export function sortSessions(sessions: Record<string, InboxSession>): InboxSession[] {
  // One O(N) classification pass, then an O(N log N) sort over cheap precomputed
  // keys. The previous version called isSessionWaitingForInput /
  // isSessionEffectivelyIdle / isConvexId inside the comparator — i.e. thousands
  // of times per sort — which dominated the constant re-categorize cost the
  // inbox pays on every liveness sync (see Chrome trace: sortSessions hot on
  // every status flip). Output order is byte-identical to the old comparator.
  const keyed: RankedSession[] = Object.values(sessions)
    .filter((s) => !isSessionHidden(s))
    .map((s) => ({ s, rank: sessionSortRank(s) }));
  keyed.sort(compareRankedSessions);
  return keyed.map((x) => x.s);
}

export function isInterruptControlMessage(raw: string | null | undefined): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

// ACTIVE_AGENT_STATUSES is imported from @codecast/shared/contracts (canonical).
const DEAD_AGENT_STATUSES: Set<string> = new Set(["stopped"]);

// Stable empty set so callers that omit pendingSendIds don't allocate and
// don't churn memoized identities.
const EMPTY_PENDING_SEND_IDS: ReadonlySet<string> = new Set<string>();

// The daemon definitively reports the agent as running. Used both to
// short-circuit idle detection and to decide when a "pending working" send has
// been confirmed (status flipped active) vs is still in-flight.
export function isAgentActive(session: Pick<InboxSession, "agent_status">): boolean {
  return !!session.agent_status && ACTIVE_AGENT_STATUSES.has(session.agent_status);
}

// A queued/optimistic outbound message is a "pending send" until the server
// echoes it back (which prunes it) or it fails. This is the durable,
// persisted, local-first signal that we've sent something and are waiting to
// confirm delivery — independent of whether ConversationView is mounted.
export function convHasPendingSend(pending?: Message[]): boolean {
  return !!pending?.some((m) => !m._isFailed);
}

// Conversation ids that currently have an unconfirmed outbound message.
export function sessionsWithPendingSend(
  pendingMessages: Record<string, Message[]>,
): Set<string> {
  const ids = new Set<string>();
  for (const id in pendingMessages) {
    if (convHasPendingSend(pendingMessages[id])) ids.add(id);
  }
  return ids;
}

// How long a blocked-banner revive request keeps its sessions rendered as
// WORKING before the (still-set) server blocked flag is allowed to resurface.
// A switch revive is kill + account swap + restart + resume + first output
// sync — tens of seconds on a healthy daemon. Past this window with the flag
// still set, the revive evidently failed and hiding the blocked state would
// lie.
export const BLOCKED_REVIVE_TTL_MS = 120_000;

// Session ids whose blocked-banner revive request is still inside the trust
// window. Classification folds these into the in-flight set (the same "the
// user already acted" forcing a queued send gets) and the banner/pill
// excludes them, so clicking continue/switch moves the fleet instantly.
export function freshReviveRequestIds(
  reviveRequestedAt: Record<string, number> | undefined,
  now: number,
): Set<string> {
  const ids = new Set<string>();
  if (!reviveRequestedAt) return ids;
  for (const id in reviveRequestedAt) {
    if (now - reviveRequestedAt[id] < BLOCKED_REVIVE_TTL_MS) ids.add(id);
  }
  return ids;
}

// Should a blocked session still wear its amber login/limit/dropped chip? Only
// while the user hasn't acted on it. Acting shows up as two local facts, the
// same pair the pill count and the banner already drop a session on: a message
// of theirs sits in the session's outbox, or a fleet revive was stamped for it.
// The server's pending_api_error clears much later — when the resumed agent's
// first real turn syncs back — so reading that flag alone left every row still
// shouting "login" after the whole fleet had been told to continue. An expired
// stamp (BLOCKED_REVIVE_TTL_MS) lets the still-set server flag resurface, so a
// revive that never happened isn't hidden.
export function showsBlockedBadge(
  pendingApiError: boolean | undefined,
  hasPendingSend: boolean,
  reviveRequestedAt: number | undefined,
  now: number,
): boolean {
  if (!pendingApiError || hasPendingSend) return false;
  return !(reviveRequestedAt != null && now - reviveRequestedAt < BLOCKED_REVIVE_TTL_MS);
}

// A pending optimistic send is "consumed" once the daemon proves it acted on it:
// the agent picked it up (status went active) or the session is dead (stopped,
// won't ever pick it up). At that point the optimistic entry is stale and must be
// dropped — otherwise it shows a phantom "pending" pill and pins an idle session
// in Working forever. This is the durable, view-independent prune that the
// echo-based prune in setMessages can't do: setMessages only runs for the
// conversation currently open AND only matches messages the server echoes back as
// user-message rows — slash commands like /model never echo, so without this they
// linger indefinitely.
export function pendingSendConsumed(
  session: Pick<InboxSession, "agent_status" | "is_idle" | "has_pending" | "updated_at"> | undefined,
  sentBaselineTs?: number,
): boolean {
  if (!session) return false;
  const status = session.agent_status;
  // Definitive positive signal: the daemon is provably acting on our send right
  // now, so the optimistic stand-in has served its purpose. A stale "working" from
  // a prior turn is harmless here — the card stays in Working either way.
  if (status && ACTIVE_AGENT_STATUSES.has(status)) return true;
  // Everything below is an ABSENCE signal ("nothing is happening") — and a stale
  // snapshot that predates our send looks identical. Only trust it once the server
  // has provably advanced PAST the send: the conversation's server-stamped
  // updated_at (bumped when the backend accepted the message) moved beyond the
  // baseline we captured at send time. Until then keep the pending pill — a
  // just-sent message must never disappear before the server has even seen it.
  const serverAdvanced = sentBaselineTs != null && (session.updated_at ?? 0) > sentBaselineTs;
  if (!serverAdvanced) return false;
  // The session is dead (stopped) and the server has caught up past our send, so
  // it was delivered-then-stopped rather than queued-against-a-live-daemon.
  if (status && DEAD_AGENT_STATUSES.has(status)) return true;
  // Server-authoritative leftover check: the backend is idle with nothing queued
  // (has_pending false) AS OF a snapshot newer than our send, so any lingering
  // client optimistic is stale — the message was delivered-and-answered, or was a
  // control command like /model that never echoes back as a user-message row. A
  // genuinely in-flight send shows has_pending true until delivered, so this can't
  // prune a real pending send.
  return !!session.is_idle && !session.has_pending;
}

// Grace window before any consumed/absence prune may fire for a send. The
// dispatch retry ladder needs several seconds to conclude a send permanently
// failed (and mark it _isFailed, which exempts it below) — pruning inside that
// window can destroy the ONLY copy of a message whose send is still in flight:
// a send into a busy foreign session reads "consumed" via the active-status
// fast path on the very next sync tick, before the server ever rejected it.
export const PENDING_SEND_PRUNE_GRACE_MS = 15_000;

// Echo hard cap. The session claiming a send consumed does NOT mean the local
// message window holds the echoed server row yet — the window back-fills via an
// async fetch (bgSyncMessages) that the same sync tick merely kicks off. Pruning
// on the claim alone makes the message vanish from a stale cached window until
// that fetch lands (~a second) when the user returns to the thread. So a consumed
// send with a warm local window is kept until its echo is visible there — but only
// up to this cap, because some sends never echo as a user-message row at all
// (control commands like /model) and a phantom pending pill would otherwise pin
// an idle session in Working forever.
export const PENDING_SEND_ECHO_CAP_MS = 60_000;

// True when the pending send's server row is already visible in the local
// message window (matched by client_id echo or direct _id).
function pendingSendEchoed(msg: Message, localMessages: Message[]): boolean {
  return localMessages.some(
    (m) => m._id === msg._id || (!!msg._clientId && m.client_id === msg._clientId),
  );
}

// Prune consumed/stale optimistic sends for a synced session. The conversation
// currently being viewed is left to setMessages (echo-based prune) so a just-sent
// message stays visible in the open thread until its real row syncs in. Failed
// sends are kept (the user may retry them). Returns true if anything changed.
export function reconcilePendingSendForSession(
  pendingMessages: Record<string, Message[]>,
  convId: string,
  session: Pick<InboxSession, "agent_status" | "is_idle" | "has_pending" | "updated_at"> | undefined,
  focusedConvId: string | null,
  // The conversation's locally cached message window, when one exists. Gates the
  // prune on the echoed server row being visible there (see PENDING_SEND_ECHO_CAP_MS).
  localMessages?: Message[],
): boolean {
  if (convId === focusedConvId) return false;
  const pending = pendingMessages[convId];
  if (!pending?.length) return false;
  // Protect the LATEST send: don't prune until the server has advanced past it.
  // Legacy entries (persisted before _sentBaselineTs existed) fall back to their
  // own client timestamp.
  let baseline = 0;
  let newestSentAt = 0;
  for (const m of pending) {
    if (m._isFailed) continue;
    baseline = Math.max(baseline, m._sentBaselineTs ?? m.timestamp);
    newestSentAt = Math.max(newestSentAt, m.timestamp);
  }
  if (newestSentAt && Date.now() - newestSentAt < PENDING_SEND_PRUNE_GRACE_MS) return false;
  if (!pendingSendConsumed(session, baseline)) return false;
  const kept = pending.filter((m) => {
    if (m._isFailed) return true;
    // Echo gate: with a warm local window, hold the send until its server row
    // is visible there (or the cap passes) so a return to the thread never
    // renders a stale window with the message missing.
    return (
      !!localMessages?.length &&
      Date.now() - m.timestamp < PENDING_SEND_ECHO_CAP_MS &&
      !pendingSendEchoed(m, localMessages)
    );
  });
  if (kept.length === pending.length) return false;
  if (kept.length === 0) delete pendingMessages[convId];
  else pendingMessages[convId] = kept;
  return true;
}

export function isSessionEffectivelyIdle(
  session: Pick<InboxSession, "is_idle" | "agent_status" | "inbox_killed_at">,
): boolean {
  // A KILLED row is retired and outranks every signal below — same precedence
  // classifyWorkState applies server-side (convex/inboxFilters.ts), which is
  // what keeps this surface and `cast sessions` telling the same story. It has
  // to win over the agent_status short-circuit too: a daemon that resurrected
  // the worker (or simply never cleared its last "working") would otherwise
  // render the retired row alive.
  if (session.inbox_killed_at) return true;
  // Daemon-reported ACTIVE statuses are a definitive "working" signal —
  // short-circuit to non-idle for fast UI response when status flips.
  if (isAgentActive(session)) {
    return false;
  }
  // Otherwise defer to the backend's composite is_idle, which already
  // factors in agent_status, recent activity, last-message role, pending
  // messages, and daemon liveness.
  return session.is_idle;
}

export function isSessionWaitingForInput(
  session: Pick<InboxSession, "_id" | "is_idle" | "agent_status" | "message_count" | "is_pinned" | "has_pending" | "awaiting_input" | "is_unresponsive" | "pending_api_error" | "inbox_killed_at">,
  sessionsWithQueuedMessages?: Set<string>,
): boolean {
  // Retired: the user already triaged this row, so nothing about it is a claim
  // on their attention — not a poll left open when the agent was torn down, not
  // a permission prompt, not a stale has_pending. First, exactly as
  // classifyWorkState puts `killed` above every other branch.
  if (session.inbox_killed_at) return false;
  const dead = !!session.agent_status && DEAD_AGENT_STATUSES.has(session.agent_status);
  const canDeliver = !session.is_unresponsive && !dead;
  // A message the user just sent/queued from the client (the durable
  // pendingMessages map, surfaced as the amber "pending" pill) means they have
  // already acted: it belongs in WORKING, not NEEDS INPUT. This wins over an
  // open poll or a permission block — sending a message IS how you answer an
  // AskUserQuestion (the free-text "Other" path) or unblock the agent, so a
  // fresh send means "I responded, get to work," never "still waiting on me."
  // NOT gated on canDeliver: the pending pill is the user's "I acted" signal and
  // the message is retried forever until even a momentarily-dead daemon (revived
  // by launchd) delivers it. A pending card must stay in Working with its pill,
  // never bounce to Needs Input. Contrast the server-only has_pending below, which
  // a dead daemon can't act on and which therefore routes to needs-attention.
  if (sessionsWithQueuedMessages?.has(session._id)) return false;
  // An open poll (AskUserQuestion) is the agent blocking on the user — the
  // definition of needs-input. It overrides the raced agent_status (the daemon
  // flips back to "working" while the poll is still open). A poll → NEEDS INPUT
  // (except pinned, which lives in its own group).
  if (session.awaiting_input && !session.is_pinned) return true;
  // The latest turn is an unresolved auth/API-error banner — the CLI got signed
  // out or rate-limited mid-turn and is parked until the user re-authenticates
  // or retries. That's the user's ball just like an open poll, so route it to
  // needs-input (where the distinct "login" badge surfaces it) instead of
  // letting it sit buried as a plain idle session.
  if (session.pending_api_error && session.message_count > 0 && !session.is_pinned) return true;
  // A permission-blocked agent (a tool-use awaiting your approve/deny) is
  // blocking on the user just like an open poll. Unlike a poll this isn't
  // reflected in awaiting_input (that derives from an AskUserQuestion tool_use),
  // so key off the daemon-reported status directly.
  if (session.agent_status === "permission_blocked") {
    return session.message_count > 0 && !session.is_pinned;
  }
  // Server-side queued message (has_pending) with no client send: counts as work
  // in flight only on a live daemon. A poll/permission block above already won,
  // so this routes a plain busy/idle session with a server-queued message to
  // working; a dead daemon falls through to the needs-attention path below.
  if (canDeliver && session.has_pending) return false;
  // Dead sessions (stopped/crashed) still need user attention if they have messages
  if (dead) {
    return session.message_count > 0 && !session.is_pinned;
  }
  return isSessionEffectivelyIdle(session) &&
    session.message_count > 0 &&
    !session.is_pinned;
}

// Where a settled-with-content session rests — the client mirror of the
// restState arm inside classifyWorkState (convex/inboxFilters.ts), field for
// field. Only meaningful for a row isSessionWaitingForInput already said yes
// to; the hard blocks that predicate resolves first (open poll, API error,
// permission prompt, dead agent) are always needs_input and never reach here.
//   dormant — a machine wake owns the next move: the agent declared it
//             (agent_status "dormant"), open background work implies it
//             ("waiting"), or the user parked the row (is_dormant, current per
//             the server's inbox_dormant_at >= updated_at rule).
//   done    — the agent declared the task delivered (agent_status "done").
//   The settle classifier's verdict (settle_verdict, current per the server)
//   speaks only when the agent made no declaration — plain idle / no status.
//   Everything else: needs_input — the ball is in the human's court.
// Dormant beats done: a session that both delivered and parked is parked.
export type SessionRestState = "needs_input" | "done" | "dormant";

export function sessionRestState(
  session: Pick<InboxSession, "agent_status" | "is_dormant" | "settle_verdict" | "thread_state_status">,
): SessionRestState {
  const status = session.agent_status;
  if (status === "dormant" || status === "waiting" || session.is_dormant) return "dormant";
  if (status === "done") return "done";
  // No daemon status at all (aged-out managed row, gone machine): the row's own
  // pinned declaration is the last word — `done` only, mirroring the server.
  if (!status && session.thread_state_status === "done") return "done";
  if (!status || status === "idle") {
    // A blocked pin is the agent's explicit claim — the classifier's soft
    // verdict never overrides it (mirrors classifyWorkState's restState arm).
    if (session.thread_state_status === "blocked") return "needs_input";
    // The classifier only ever files DONE — dormancy needs a wake the system
    // can verify (convex/idleSummary.ts SETTLE_VERDICTS); a stale "dormant" is ignored.
    if (session.settle_verdict === "done") return "done";
  }
  return "needs_input";
}

// The hard-block subset of isSessionWaitingForInput: true when the row is
// waiting on the human for a reason no rest verdict may soften. Used by
// categorizeSessions to keep a hard-blocked row out of Done / Dormant even
// when it carries a stale declaration or a park stamp.
function isSessionHardWaiting(
  session: Pick<InboxSession, "agent_status" | "message_count" | "awaiting_input" | "is_unresponsive" | "pending_api_error">,
): boolean {
  if (session.awaiting_input) return true;
  if (session.pending_api_error && session.message_count > 0) return true;
  if (session.agent_status === "permission_blocked") return true;
  const dead = !!session.agent_status && DEAD_AGENT_STATUSES.has(session.agent_status);
  if (dead || session.is_unresponsive) return true;
  return false;
}

// A concrete blocker that must escalate even for a STANDING session (one with a
// recurring schedule injecting into it) or a scheduled run collapsed under its
// schedule's group row: an open poll, an unresolved auth/API error, a permission
// prompt, or a dead agent with content. Mirrors isSessionWaitingForInput branch
// for branch — same fields, same precedence — EXCEPT the fallthrough: a plain
// finished turn (effectively idle with messages) is the uneventful steady state
// of standing automation, not a claim on the user's attention, so it does not
// count as blocked here. No pinned exemption either: placement of pinned rows
// is the caller's concern (they never leave the Pinned group).
export function isSessionHardBlocked(
  session: Pick<InboxSession, "_id" | "agent_status" | "message_count" | "has_pending" | "awaiting_input" | "is_unresponsive" | "pending_api_error" | "inbox_killed_at">,
  sessionsWithQueuedMessages?: Set<string>,
): boolean {
  if (sessionsWithQueuedMessages?.has(session._id)) return false;
  // Retired outranks every blocker below, same as in isSessionWaitingForInput
  // and classifyWorkState. It matters most here because this predicate is what
  // pulls an ANCHOR out of its own space and into the inbox (categorizeSessions'
  // hiddenAnchor gate): a killed anchor keeps its frozen awaiting_input /
  // permission_blocked, so without this it re-escalated forever after teardown.
  if (session.inbox_killed_at) return false;
  if (session.awaiting_input) return true;
  if (session.pending_api_error && session.message_count > 0) return true;
  if (session.agent_status === "permission_blocked") return session.message_count > 0;
  const dead = !!session.agent_status && DEAD_AGENT_STATUSES.has(session.agent_status);
  if (!session.is_unresponsive && !dead && session.has_pending) return false;
  if (dead) return session.message_count > 0;
  return false;
}

// Per-session-object memo for the two costliest classification predicates.
// categorizeSessions runs on every REAL session change (a single agent flipping
// working↔idle re-buckets the whole list), and over a never-pruned store that
// means re-deriving classification for thousands of unchanged rows each time.
//
// The win comes from object identity: the liveness overlay (syncOverlay) and
// applySyncTable both preserve a session row's reference unless one of its fields
// actually changed, so keying by the row object lets an unchanged session reuse
// its prior verdict — the recompute then scales with the number of CHANGED rows,
// not the total store. Both predicates are pure in the session object (no
// Date.now(), no external set), which is what makes object-identity memoization
// sound; a changed row arrives as a new object and misses the cache. WeakMap so
// entries vanish with their session (eviction / replacement) — no leak, no stale
// key. `waiting` here is the no-in-flight verdict; categorize layers the tiny
// in-flight set on top (an in-flight send forces a session OUT of needs-input).
const _classifyCache = new WeakMap<object, { idle: boolean; waiting: boolean; rest: SessionRestState }>();
export function classifySession(s: InboxSession): { idle: boolean; waiting: boolean; rest: SessionRestState } {
  let c = _classifyCache.get(s);
  if (!c) {
    const waiting = isSessionWaitingForInput(s);
    // `rest` refines a `waiting` verdict into its section; a hard block is
    // always needs_input, whatever verdict the row also carries.
    const rest: SessionRestState = waiting && !isSessionHardWaiting(s) ? sessionRestState(s) : "needs_input";
    c = { idle: isSessionEffectivelyIdle(s), waiting, rest };
    _classifyCache.set(s, c);
  }
  return c;
}

export function getSessionRenderKey(
  session: Pick<InboxSession, "_id" | "session_id"> | null | undefined,
): string | null {
  if (!session) return null;
  return (session as InboxSession).session_id || session._id;
}

export function isSub(s: InboxSession): boolean {
  return !!s.is_subagent || !!s.parent_conversation_id || !!s.worktree_name;
}

export function isFork(s: InboxSession): boolean {
  return !!s.forked_from;
}

// Group key for a session running in an isolated worktree (an orchestration
// worker), or null for an ordinary checkout. Workers spawned for a plan/task
// land in `.codecast/worktrees/<name>` (or `.conductor/<name>` for the `wt`
// helper); we cluster them under that name in the inbox so a fan-out reads as
// one collapsible group instead of N loose top-level cards. Prefers the
// explicit worktree_name, falling back to parsing the project path.
const WORKTREE_PATH_RE = /\/\.(?:codecast\/worktrees|conductor)\/([^/]+)/;
export function worktreeKeyOf(s: InboxSession): string | null {
  if (s.worktree_name) return s.worktree_name;
  const path = s.project_path || s.git_root || "";
  const m = path.match(WORKTREE_PATH_RE);
  return m ? m[1] : null;
}

// Display label for a session's plan (or worktree) grouping, used by the
// "By plan" view's section headings, or null if the session carries neither.
// Prefers the PLAN — the reliable, persisted signal (active_plan) — and falls
// back to the worktree for an isolated session without a plan. The label
// doubles as the group's identity (plan short_id keeps distinct plans apart).
export function orchestrationGroupLabelOf(s: InboxSession): string | null {
  if (s.active_plan) {
    const title = s.active_plan.title?.trim();
    return title ? `${s.active_plan.short_id} · ${title}` : s.active_plan.short_id;
  }
  const wt = worktreeKeyOf(s);
  return wt ? `⑂ ${wt}` : null;
}

// Structural signature of a session for inbox bucketing + ordering. It MUST fold
// in every field that decides which section/position a row lands in — so it is
// built FROM sessionSortRank (the order tuple, which already folds in
// classifySession's idle/waiting verdict) plus the grouping/visibility flags
// categorizeSessions splits on. Building it this way means it can't drift from
// the categorizer. It deliberately OMITS updated_at / last_heartbeat /
// last_message_at and the raw message_count (only the message_count===0 boundary,
// carried inside the rank tuple, changes a bucket): a heartbeat or a streamed
// token must not move anything, so it must not change this signature.
//
// Subscribe a list/sidebar to sessionsWakeSig(s.sessions) instead of the raw
// `s.sessions` map and it wakes only on real structural change, not on every
// liveness tick. The TIME-driven reclassification categorizeSessions performs
// (the trust-TTL sweep that retires a stale "working" to needs-input) is NOT a
// field change — drive that with a coarse re-render ticker (useCoarseNow), never
// by widening this signature. See store/wakeSig.ts.
export function sessionStructuralSig(s: InboxSession): string {
  return [
    s._id,
    sessionSortRank(s).join(","),
    isSessionHidden(s) ? 1 : 0,
    isSessionDismissed(s) ? 1 : 0,
    isSessionStashed(s) ? 1 : 0,
    nestParentIdOf(s) || "",
    s.forked_from || "",
    orchestrationGroupLabelOf(s) || "",
    // Presence of an unacked assignment flips the row's prominent treatment.
    // Changes only on assign/ack, never on heartbeats.
    s.assigned_ping ? 1 : 0,
    // Harness loop state decides trigger-set membership and absorption
    // (partitionTriggerInbox reads it off this same subscription). Distilled to
    // the fields that change rows; stamps once per turn end/wakeup, never on
    // heartbeats.
    s.loop_state ? `${s.loop_state.status}:${s.loop_state.wakeup_at}` : "",
    // Row thumbnail (inbox_image_thumbs pref). Changes only when a NEW image
    // lands in the session — never on heartbeats — so folding it in is cheap
    // and keeps the thumb from waiting on the coarse ticker.
    s.image_preview_url || "",
    // The agent's pinned thread state replaces the card's summary line. The
    // TIMESTAMP stands in for the text: every write stamps a new one, so the
    // signature stays short while still waking the card on a rewrite. Set by
    // `cast state` only — a few times per session, never on heartbeats.
    s.thread_state_at || 0,
    // Open teammate-comment threads — the card's comment chip. Changes only
    // when a human posts/resolves a comment, never on heartbeats. Paints a
    // chip; never moves a row between buckets, so it stays out of sortRank.
    // last_comment_at stands in for the author/excerpt text (every comment
    // write stamps a new timestamp), the same trick thread_state_at uses.
    s.open_comment_threads || 0,
    s.last_comment_at || 0,
  ].join("\x1f");
}

// Collection wake signature over the whole session map (memoized by map ref).
export const sessionsWakeSig = makeCollectionSig<InboxSession>(sessionStructuralSig);

// Membership signature over pending sends, memoized by the pendingMessages ref.
// pendingMessages mutates on every send-lifecycle tick, but categorizeSessions
// only cares WHICH conversations have an unconfirmed send — subscribe to this
// instead of the raw map and a badge/panel wakes only when that set changes.
let _pendingSendSigRef: unknown;
let _pendingSendSig = "";
// The mine-scoped inbox categorization, shared by every surface that mirrors
// the inbox (sidebar count badge, active-agents badge, dock badge). One
// ref-keyed cache so N consumers cost one categorize pass per structural
// change instead of N (each pass walks the whole never-prune session cache).
// `coarseNow` keeps the trust-TTL sweep alive; pass the caller's coarse clock.
let _mineCatKey: unknown[] | null = null;
let _mineCatValue: CategorizedSessions | null = null;
export function categorizeMineSessions(s: InboxStoreState, coarseNow: number): CategorizedSessions {
  const meId = s.currentUser?._id ? s.currentUser._id.toString() : null;
  const showOld = resolveShowOld(s.clientState.ui);
  const key = [sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), s.liveInboxIds, showOld, coarseNow];
  if (_mineCatKey && _mineCatValue && key.length === _mineCatKey.length && key.every((v, i) => Object.is(v, _mineCatKey![i]))) return _mineCatValue;
  _mineCatValue = categorizeSessions(
    filterInboxScope(s.sessions, "mine", meId),
    s.sessionsWithQueuedMessages,
    sessionsWithPendingSend(s.pendingMessages),
    { liveInboxIds: s.liveInboxIds, showOld, reviveRequestedAt: s.blockedReviveRequestedAt },
  );
  _mineCatKey = key;
  return _mineCatValue;
}

export function pendingSendWakeSig(pendingMessages: Record<string, Message[]>): string {
  if (pendingMessages === _pendingSendSigRef) return _pendingSendSig;
  const ids: string[] = [];
  for (const id in pendingMessages) {
    if (convHasPendingSend(pendingMessages[id])) ids.push(id);
  }
  _pendingSendSigRef = pendingMessages;
  _pendingSendSig = ids.sort().join(",");
  return _pendingSendSig;
}

export interface CategorizedSessions {
  sorted: InboxSession[];
  pinned: InboxSession[];
  newSessions: InboxSession[];
  // The three settled sections, by who acts next (see sessionRestState).
  needsInput: InboxSession[];
  done: InboxSession[];
  dormant: InboxSession[];
  working: InboxSession[];
  stashed: InboxSession[];
  dismissed: InboxSession[];
  subsByParent: Map<string, InboxSession[]>;
  forksByParent: Map<string, InboxSession[]>;
  // Count of cached rows hidden as "old" (absent from the live/authoritative
  // inbox set) — drives the "show N old sessions" toggle badge. 0 when showOld
  // is on or no liveInboxIds was supplied.
  oldCount: number;
}

export function categorizeSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
  pendingSendIds: ReadonlySet<string> = EMPTY_PENDING_SEND_IDS,
  opts: {
    currentSessionId?: string | null;
    pendingCreateIds?: ReadonlySet<string>;
    // The AUTHORITATIVE active-inbox id set (server's listInboxSessions result,
    // piped into store.liveInboxIds). When supplied, a cached top-level row absent
    // from it is "old" — backfilled by the completeness crawl for search/open, but
    // NOT part of the actionable inbox. Folding this in (instead of a separate
    // partitionOldSessions pre-pass every caller must remember) is what makes EVERY
    // consumer — panel, sidebar badge, dashboard badge, palette — render the same
    // server-authoritative set, so the inbox is identical across web/desktop/mobile
    // and never accumulates aged-out cruft. Omit it (or pass showOld) to keep the
    // whole cache — the safe fallback used before the first live payload lands.
    liveInboxIds?: Set<string>;
    // Default HIDE old. Pass true for the "show old sessions" browse toggle.
    showOld?: boolean;
    // Blocked-banner revive stamps (store.blockedReviveRequestedAt). Fresh
    // entries join the in-flight set below, so a fleet the user just told to
    // continue/switch renders as WORKING immediately instead of waiting for
    // the daemon round trip to clear pending_api_error. TTL-checked here
    // (Date.now(), like the trust sweep) so an expired stamp resurfaces the
    // blocked state on the callers' coarse-clock re-runs.
    reviveRequestedAt?: Record<string, number>;
  } = {},
): CategorizedSessions {
  // Single walk over the whole input, splitting it into the three top-level
  // slices below in one pass instead of three separate Object.values scans. This
  // is the per-status-flip hot path over the entire never-pruned store — and the
  // input still carries every KILLED/STASHED row (they aren't "old", so the
  // old-session partition keeps them), so collapsing 3×N scans into 1×N is the
  // cut that matters. Output is identical: active uses the shared rank
  // comparator; dismissed/stashed keep their newest-first sorts (stable sort over
  // the same Object.values order).
  const activeKeyed: RankedSession[] = [];
  const dismissed: InboxSession[] = [];
  const stashed: InboxSession[] = [];
  // Fold the "old" (absent-from-authoritative-set) hiding into this single walk
  // instead of a separate partitionOldSessions pass — one scan, and every caller
  // gets it for free. Only hide when we actually have the live set (size>0) and
  // showOld is off; an empty set means the first live payload hasn't landed, so
  // show everything (never blank the inbox on cold open). isOldSession already
  // exempts pinned / focused / dismissed / stashed / subagents, so hiding here
  // only ever removes stale top-level active cards — their dismissed/stashed twins
  // still fall through to those buckets below.
  const canHideOld = !opts.showOld && !!opts.liveInboxIds && opts.liveInboxIds.size > 0;
  const focusedId = opts.currentSessionId ?? null;
  let oldCount = 0;
  for (const s of Object.values(sessions)) {
    const isOld = canHideOld && isOldSession(s, opts.liveInboxIds!, focusedId);
    if (isOld) oldCount++;
    // An anchor's standing thread lives in its dedicated /anchor space, not the
    // inbox — surface it here ONLY when it's genuinely blocked on the user (an open
    // poll, permission prompt, auth error, or a dead session with output), NOT
    // every time it finishes a turn and goes idle. It drops back to its space once
    // handled.
    const hiddenAnchor = !!s.is_anchor && !isSessionHardBlocked(s);
    if (!isOld && !isSessionHidden(s) && !hiddenAnchor) activeKeyed.push({ s, rank: sessionSortRank(s) });
    if (isSessionDismissed(s)) dismissed.push(s);
    if (isSessionStashed(s)) stashed.push(s);
  }
  activeKeyed.sort(compareRankedSessions);
  const sorted = activeKeyed.map((x) => x.s);
  dismissed.sort((a, b) => (b.inbox_dismissed_at || 0) - (a.inbox_dismissed_at || 0));
  stashed.sort((a, b) => (b.inbox_stashed_at || 0) - (a.inbox_stashed_at || 0));
  const allIds = new Set(sorted.map((s) => s._id));

  // Nest parent covers BOTH child kinds (see nestParentIdOf): Task-tool
  // subagents (parent_conversation_id) and agent-team teammates
  // (spawned_by_conversation_id + agent_team_name). Nesting is positional —
  // only when the parent is in this set. A parentless teammate stays a normal
  // flat card below (it's NOT isSubagentConversation, so the orphan hiding
  // doesn't apply to it); a parentless Task subagent is hidden as before.
  const subsByParent = new Map<string, InboxSession[]>();
  for (const s of sorted) {
    const nestParent = nestParentIdOf(s);
    if (nestParent && allIds.has(nestParent)) {
      if (!subsByParent.has(nestParent)) subsByParent.set(nestParent, []);
      subsByParent.get(nestParent)!.push(s);
    }
  }
  for (const subs of subsByParent.values()) {
    subs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  const forksByParent = new Map<string, InboxSession[]>();
  for (const s of sorted) {
    if (s.forked_from && allIds.has(s.forked_from)) {
      if (!forksByParent.has(s.forked_from)) forksByParent.set(s.forked_from, []);
      forksByParent.get(s.forked_from)!.push(s);
    }
  }
  for (const forks of forksByParent.values()) {
    forks.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  }

  const subsWithParent = new Set(Array.from(subsByParent.values()).flat().map((s) => s._id));

  const isTop = (s: InboxSession) => !subsWithParent.has(s._id);

  // A subagent whose parent did NOT nest above it (parent absent from this set).
  // The server only ever emits a subagent ALONGSIDE its parent, so a parentless
  // subagent here means the parent was filtered out locally — the "old sessions"
  // partition dropping an old parent is the common case — or hard-deleted. Such a
  // row must never be PROMOTED into the flat active buckets: doing so makes it
  // masquerade as a top-level needs-input card that ignores BOTH the old-sessions
  // toggle (it has a parent id, so isOldSession skips it) and the subagent toggle
  // (it isn't in subsByParent, so the nested-subagent filter never sees it). It
  // rides its parent — nested when the parent is present, hidden otherwise.
  // (Pinned is exempt below: an explicit pin is a deliberate "keep visible".)
  const isOrphanSubagent = (s: InboxSession) => isSubagentConversation(s) && !subsWithParent.has(s._id);

  // Flat = top-level and not an orphaned subagent (those ride their parent —
  // never a loose card here). Plan/worktree clustering is deliberately NOT done
  // here: the status view is about status, so a working session must always
  // surface in Working (and count in the sidebar badges). Grouping by plan is
  // the "By plan" view's job (groupSessionsByPlan), opted into via the view
  // switcher.
  const isFlat = (s: InboxSession) => isTop(s) && !isOrphanSubagent(s);

  // A pending send is in-flight work just like a locally-queued message: it
  // pushes the session OUT of needs-input and INTO working. Fold the two sets
  // so the existing isSessionWaitingForInput guard handles both with no extra
  // param. A brand-new session (message_count 0) with a pending first message
  // also belongs in Working, not New.
  const reviveIds = freshReviveRequestIds(opts.reviveRequestedAt, Date.now());
  const inFlight = pendingSendIds.size === 0 && reviveIds.size === 0
    ? sessionsWithQueuedMessages
    : new Set<string>([...sessionsWithQueuedMessages, ...pendingSendIds, ...reviveIds]);
  const hasPendingSend = (s: InboxSession) => pendingSendIds.has(s._id);
  // Safety net for rows the liveness overlay can no longer refresh. The base
  // session cache never prunes (isDelta) but the sessionsLiveness overlay only
  // covers the current inbox window, so a session that ages out keeps its
  // last-synced live status frozen — often a "working" its daemon never un-set.
  // Because the working bucket is a fallthrough (anything not waiting-for-input
  // with messages), such a frozen-active row is pinned in WORKING forever.
  // Mirror the backend's trustedAgentStatus: past the trust TTL with no fresh
  // activity the status is stale, so a settled session with content belongs in
  // needs-input. Keyed on updated_at — the one field that stays accurate when
  // live status is frozen (a genuinely working agent bumps it far more often
  // than the TTL, so it's never caught). Date.now() here (not in the pure,
  // memoized classifySession) so the verdict re-evaluates as time passes.
  const now = Date.now();
  // Shared staleness core (isLivenessStale) + the bucket's own pinned policy:
  // pinned rows live in the Pinned group regardless, so they're never swept here.
  // Two speeds inside the core: an ACTIVE agent_status gone quiet keeps the 1h
  // trust TTL, while a row with NO active status (killed / subagent / unmanaged
  // rows the overlay never covers, whose is_idle froze at null or false) settles
  // after the 45s idle grace — nothing ever claimed those were working, so they
  // get no benefit of the doubt.
  const isTrustStale = (s: InboxSession) => isLivenessStale(s, now) && !s.is_pinned;
  // Classify waiting-for-input ONCE per session (it's the costliest predicate and
  // was evaluated twice below — in the needsInput and working filters). The
  // memoized verdict (classifySession) is the no-in-flight result; an in-flight
  // send forces the session OUT of needs-input, so layer that tiny set on top.
  // A pending send always wins (the amber pill keeps it in Working), so it's
  // never overridden by the staleness net.
  const waitingForInput = new Map<string, boolean>();
  for (const s of sorted) {
    if (inFlight.has(s._id)) { waitingForInput.set(s._id, false); continue; }
    waitingForInput.set(s._id, classifySession(s).waiting || isTrustStale(s));
  }

  // Pinning is a manual curation gesture, so the Pinned group gets its own
  // stable order by pin time (oldest pin first, new pins append to the bottom)
  // — never the activity-based sortSessions order, which reshuffles cards
  // whenever an agent's status flickers (working/idle, poll open/close), even
  // while the user reads them. Ascending keeps existing pins put when you add
  // a new one.
  const pinned = sorted
    .filter((s) => s.is_pinned && isTop(s))
    .sort((a, b) => {
      const at = a.inbox_pinned_at ?? 0;
      const bt = b.inbox_pinned_at ?? 0;
      if (at !== bt) return at - bt;
      return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
    });
  // A never-engaged blank (0 messages, not the session you're on, no in-flight
  // create) is quick-create pre-warm infrastructure, not work — rendering it as
  // an inbox card is the "ghost New Session" cruft users kept dismissing. The
  // row stays in the cache for palette reuse; it just doesn't render until
  // engaged (current / mid-create here, or its first send moves it to Working).
  const isEngagedBlank = (s: InboxSession) =>
    s._id === opts.currentSessionId || !!opts.pendingCreateIds?.has(s._id) || !!s._hasDraft;
  const newSessions = sorted.filter((s) => s.message_count === 0 && !s.is_pinned && !hasPendingSend(s) && isFlat(s) && isEngagedBlank(s))
    .sort((a, b) => (a.is_connected ? 1 : 0) - (b.is_connected ? 1 : 0));
  // The settled rows split by who acts next (classifySession's `rest`): blocked
  // → Needs Input, delivered → Done, parked on a machine wake → Dormant. The
  // staleness net above only says "settled"; a row it caught still carries its
  // own rest verdict, so a declared-dormant home quiet for a day stays Dormant.
  const settled = sorted.filter((s) => waitingForInput.get(s._id) && isFlat(s));
  const restOf = (s: InboxSession): SessionRestState => classifySession(s).rest;
  // Needs Input and Done are both queues you clear top-down: oldest first, so
  // the item that has waited longest sits at the top and a fresh arrival never
  // displaces what you're reading. Defer (shift+backspace, "send to bottom")
  // sinks a row below the rest of its group regardless of timestamp — one
  // comparator for both so the gesture works the same wherever the row rests.
  const settledQueueOrder = (a: InboxSession, b: InboxSession) => {
    if (!!a.is_deferred !== !!b.is_deferred) return a.is_deferred ? 1 : -1;
    return (a.updated_at || 0) - (b.updated_at || 0);
  };
  const needsInput = settled.filter((s) => restOf(s) === "needs_input").sort(settledQueueOrder);
  const done = settled.filter((s) => restOf(s) === "done").sort(settledQueueOrder);
  // Most recently parked first.
  const dormant = settled.filter((s) => restOf(s) === "dormant")
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const working = sorted.filter((s) => (!waitingForInput.get(s._id) && (s.message_count > 0 || hasPendingSend(s)) && !s.is_pinned) && isFlat(s));

  return { sorted, pinned, newSessions, needsInput, done, dormant, working, stashed, dismissed, subsByParent, forksByParent, oldCount };
}

export function visualOrderSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
  projectFilter?: string | null,
  pendingSendIds: ReadonlySet<string> = EMPTY_PENDING_SEND_IDS,
  opts: {
    currentSessionId?: string | null;
    pendingCreateIds?: ReadonlySet<string>;
    // Active bucket chip: scope keyboard nav / advance to the focused bucket,
    // mirroring the project filter. bucketByConv comes from convBucketMap().
    bucketFilter?: string | null;
    bucketByConv?: Record<string, string | undefined>;
    // Exclude mode: the active chip HIDES its matches instead of focusing them.
    filterExclude?: boolean;
    // Grouped-view collapse: when provided, sessions inside a collapsed status
    // section are skipped, so Ctrl+J/K only walks cards the panel is actually
    // rendering. Keys mirror GlobalSessionPanel's renderSection keys
    // ("pinned"/"new"/"needs_input"/"working").
    collapsedSections?: Record<string, boolean>;
    // Status-view schedule projection (grouped mode only), published by the
    // panel from the agentTasks.webList join: sessions absorbed behind a
    // TRIGGERS row — a resting loop's home conversation, or an uneventful
    // spawned run — are parked on that trigger's next fire, so a settled one
    // walks with the DORMANT section (where the panel renders it) instead of
    // its own bucket. Escalated ones aren't in this set.
    absorbedIds?: ReadonlySet<string>;
    // See categorizeSessions — forwarded through.
    reviveRequestedAt?: Record<string, number>;
    // Status view only: the QUESTIONS section's inputs (lib/decisionQueue
    // liftQuestions) — pending `cast decide` rows and the viewer's own
    // sessions, unscoped, so a question hidden by scope still walks.
    questions?: { decisions: Record<string, SessionDecisionItem>; mine: Record<string, InboxSession>; resolutions?: QuestionResolutions };
  } = {},
): InboxSession[] {
  const { pinned, newSessions, needsInput, done, dormant, working } =
    categorizeSessions(sessions, sessionsWithQueuedMessages, pendingSendIds, opts);
  const collapsed = opts.collapsedSections;
  // Questions lift out of every other section (the ask outranks placement),
  // exactly as the panel renders; without the inputs nothing lifts.
  const { questions, isQuestion } = opts.questions
    ? liftQuestions([pinned, newSessions, needsInput, done, dormant, working], opts.questions.decisions, opts.questions.mine, opts.questions.resolutions)
    : { questions: [] as InboxSession[], isQuestion: () => false };
  const rest = (arr: InboxSession[]) => (opts.questions ? arr.filter((s) => !isQuestion(s)) : arr);
  const absorbed = opts.absorbedIds?.size ? opts.absorbedIds : null;
  const stripAbsorbed = (arr: InboxSession[]) =>
    absorbed ? arr.filter((s) => !absorbed.has(s._id)) : arr;
  const absorbedSettled = absorbed
    ? [...needsInput, ...done].filter((s) => absorbed.has(s._id))
    : [];
  const result: InboxSession[] = [];
  // Same order the status view renders: questions, pinned, new, needs input,
  // done, working, dormant (declared/inferred parks first, then absorbed rests).
  const sections: Array<[InboxSession[], string]> = [
    [questions, "questions"], [rest(pinned), "pinned"], [rest(newSessions), "new"],
    [rest(stripAbsorbed(needsInput)), "needs_input"], [rest(stripAbsorbed(done)), "done"],
    [rest(working), "working"], [rest([...dormant, ...absorbedSettled]), "dormant"],
  ];
  for (const [section, key] of sections) {
    if (collapsed?.[key]) continue;
    for (const s of section) {
      if (projectFilter) {
        const m = getProjectName(s.git_root, s.project_path) === projectFilter;
        if (opts.filterExclude ? m : !m) continue;
      }
      if (opts.bucketFilter) {
        const m = opts.bucketByConv?.[s._id] === opts.bucketFilter;
        if (opts.filterExclude ? m : !m) continue;
      }
      result.push(s);
    }
  }
  return result;
}

// Canonical label ordering — ONE comparator drives the chip row, the "by
// label" view's sections, the overflow popover, and keyboard order. Explicit
// sort_order first (drag-reorder writes it), name as the stable tiebreak for
// never-ordered labels.
export function sortLabels(buckets: Record<string, BucketItem>): BucketItem[] {
  return (Object.values(buckets) as BucketItem[])
    .filter((b) => !b.archived_at)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
}

// Label/project view counts over the panel's "active" sessions. ONE source for
// every surface that lists the views (the session-panel chip row, the palette
// view switcher) so they can never disagree about what each view contains.
export function computeChipCounts(
  activeSessions: InboxSession[],
  bucketByConv: Record<string, string | undefined>,
): {
  bucketCounts: Record<string, number>;
  projectCounts: Array<[string, number]>;
  projectPathByName: Record<string, string>;
} {
  const bucketCounts: Record<string, number> = {};
  const projCounts: Record<string, number> = {};
  const projectPathByName: Record<string, string> = {};
  for (const s of activeSessions) {
    const b = bucketByConv[s._id];
    if (b) bucketCounts[b] = (bucketCounts[b] || 0) + 1;
    const name = getProjectName(s.git_root, s.project_path);
    if (name !== "unknown") {
      projCounts[name] = (projCounts[name] || 0) + 1;
      if (!projectPathByName[name]) projectPathByName[name] = s.git_root || s.project_path || "";
    }
  }
  return {
    bucketCounts,
    projectCounts: Object.entries(projCounts).sort((a, b) => b[1] - a[1]),
    projectPathByName,
  };
}

// Default project for a brand-new session seeded from the compose popup. A
// caller-supplied context (doc review passes the doc's own project) wins — it's
// the explicit target. Otherwise the current conversation's project — except
// that an active project-filter chip is an explicit "I'm working in this
// project" (same rule as Ctrl+N's resolveNewSessionContext in DashboardLayout):
// the conversation only seeds the default when it lives inside the filtered
// project; otherwise the filter's own path wins. Then the most recent project.
// Can resolve to nothing — the daemon starts in $HOME and the null-state
// ProjectSwitcher lets the user pick before send.
//
// The conversation being viewed can be a TEAMMATE's (team inbox/feed), whose
// checkout lives on a machine none of the user's devices has — a new session
// can't start there, so its path never seeds (pathOnMyMachines against the
// device roster; unloaded roster doesn't filter).
export function resolveComposeProjectPath(opts: {
  context?: { projectPath?: string; gitRoot?: string };
  conversation: { projectPath?: string; gitRoot?: string };
  activeProjectFilter?: string | null;
  activeProjectPath?: string | null;
  // Exclude-mode chip: "everything but this project" expresses no preference
  // for where a NEW session should live, so the filter neither vetoes the
  // conversation's path nor seeds its own.
  chipFilterExclude?: boolean;
  recentProjects?: Array<{ path: string }>;
  machineRoster?: Array<Pick<MachineCandidate, "local_project_roots">>;
}): string | undefined {
  const { context, conversation, recentProjects, machineRoster } = opts;
  const activeProjectFilter = opts.chipFilterExclude ? null : opts.activeProjectFilter;
  const activeProjectPath = opts.chipFilterExclude ? null : opts.activeProjectPath;
  const rawConvPath =
    !activeProjectFilter || getProjectName(conversation.gitRoot, conversation.projectPath) === activeProjectFilter
      ? conversation.projectPath || conversation.gitRoot
      : undefined;
  const convPath =
    rawConvPath && (!machineRoster || pathOnMyMachines(machineRoster, rawConvPath)) ? rawConvPath : undefined;
  return context?.projectPath || context?.gitRoot || convPath || activeProjectPath || recentProjects?.[0]?.path || undefined;
}

// The directory a label filter implies for a NEW session. Labels carry no
// project of their own (inbox_buckets has no path), so derive one from the
// label's members: the most recently updated session filed under it whose
// checkout lives on one of my machines. Only an INCLUDE chip seeds — an
// exclude chip ("everything but X") is a hide, not a place to start work.
export function bucketProjectPath(state: {
  activeBucketFilter: string | null;
  chipFilterExclude: boolean;
  sessions: Record<string, InboxSession>;
  bucketAssignments: Record<string, BucketAssignmentItem>;
  machineRoster?: Array<Pick<MachineCandidate, "local_project_roots">>;
}): string | undefined {
  if (!state.activeBucketFilter || state.chipFilterExclude) return undefined;
  const bucketByConv = convBucketMap(state.bucketAssignments);
  let best: InboxSession | undefined;
  for (const s of Object.values(state.sessions)) {
    if (bucketByConv[s._id] !== state.activeBucketFilter) continue;
    const p = s.git_root || s.project_path;
    if (!p || (state.machineRoster && !pathOnMyMachines(state.machineRoster, p))) continue;
    if (!best || s.updated_at > best.updated_at) best = s;
  }
  return best ? best.git_root || best.project_path : undefined;
}

// Find a checkout of a project by name among everything we know about —
// recent projects first (the user's own machines, freshest), then session
// rows, then the machine roster's project roots. Paths a machine of mine
// doesn't have are skipped (same roster rule as resolveComposeProjectPath).
// The error toast uses this to pin "Just fix" sessions to the codecast repo:
// those errors are crashes of the codecast client itself, so the fix belongs
// there no matter what project the user happens to be viewing.
export function findProjectPathByName(
  name: string,
  opts: {
    sessions?: Record<string, InboxSession>;
    recentProjects?: Array<{ path: string }>;
    machineRoster?: Array<Pick<MachineCandidate, "local_project_roots">>;
  },
): string | undefined {
  const { sessions, recentProjects, machineRoster } = opts;
  const onMine = (p: string) => !machineRoster || pathOnMyMachines(machineRoster, p);
  const recent = recentProjects?.find((r) => getProjectName(r.path) === name && onMine(r.path));
  if (recent) return recent.path;
  for (const s of Object.values(sessions ?? {})) {
    const p = s.git_root || s.project_path;
    if (p && getProjectName(s.git_root, s.project_path) === name && onMine(p)) return p;
  }
  for (const d of machineRoster ?? []) {
    const root = d.local_project_roots?.find((r) => getProjectName(r) === name);
    if (root) return root;
  }
  return undefined;
}

// Drag-reorder math. Express the drop as "move ordered[fromIndex] so it ends
// up at finalIndex", and return the minimal sort_order writes that realize it.
// Fractional midpoints keep a typical reorder to ONE write; the first-ever
// reorder (labels still on the name-tiebreak with no explicit orders) and
// float-precision collapse renumber the whole list onto a fresh ladder.
const SORT_GAP = 1024;
export function computeReorderUpdates(
  ordered: BucketItem[],
  fromIndex: number,
  toIndex: number,
): Array<{ id: string; sort_order: number }> {
  if (fromIndex < 0 || fromIndex >= ordered.length) return [];
  const moved = ordered[fromIndex];
  const rest = ordered.filter((_, i) => i !== fromIndex);
  const finalIndex = Math.max(0, Math.min(toIndex, rest.length));
  const result = [...rest.slice(0, finalIndex), moved, ...rest.slice(finalIndex)];
  if (result.every((b, i) => b._id === ordered[i]._id)) return [];
  const needsInit = ordered.some((b) => typeof b.sort_order !== "number");
  if (!needsInit) {
    const before = result[finalIndex - 1]?.sort_order;
    const after = result[finalIndex + 1]?.sort_order;
    const newOrder = before == null
      ? (after as number) - SORT_GAP
      : after == null
        ? before + SORT_GAP
        : (before + after) / 2;
    if (Number.isFinite(newOrder) && newOrder !== before && newOrder !== after) {
      return [{ id: moved._id, sort_order: newOrder }];
    }
  }
  return result.map((b, i) => ({ id: b._id, sort_order: (i + 1) * SORT_GAP }));
}

// Newest-activity-first, the within-group order shared by every grouping below.
// NB: keyed on updated_at, which the inbox's wake signature deliberately omits —
// so a re-sort here rides the panel's coarse clock (useCoarseNow), not a sig flip.
const byActivity = (a: InboxSession, b: InboxSession) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

// Project-fallback groups, biggest first with "other" last — the auto-derived
// label tier every view falls back to for items that carry no primary key.
function buildProjectGroups(byProject: Map<string, InboxSession[]>): Array<{ name: string; items: InboxSession[] }> {
  return Array.from(byProject.entries())
    .map(([name, list]) => ({ name, items: list.sort(byActivity) }))
    .sort((a, b) =>
      (a.name === "other" ? 1 : 0) - (b.name === "other" ? 1 : 0) || b.items.length - a.items.length);
}

// The grouping skeleton shared by the label and plan views: dedup the input, bin
// each session under its primary key (keyOf) or — when it has none (keyOf → null)
// — under its project, then hand the primary bins to the caller to order/shape as
// it sees fit. Owns the dedup loop, the project fallback, and the project-group
// build so the two views don't each re-implement them.
function groupSessionsBy<G>(
  items: InboxSession[],
  keyOf: (s: InboxSession) => string | null,
  buildPrimary: (byPrimary: Map<string, InboxSession[]>) => G[],
): { primaryGroups: G[]; projectGroups: Array<{ name: string; items: InboxSession[] }> } {
  const byPrimary = new Map<string, InboxSession[]>();
  const byProject = new Map<string, InboxSession[]>();
  const seen = new Set<string>();
  for (const sess of items) {
    if (seen.has(sess._id)) continue;
    seen.add(sess._id);
    const k = keyOf(sess);
    if (k !== null) {
      if (!byPrimary.has(k)) byPrimary.set(k, []);
      byPrimary.get(k)!.push(sess);
    } else {
      const project = getProjectName(sess.git_root, sess.project_path);
      const pkey = project === "unknown" ? "other" : project;
      if (!byProject.has(pkey)) byProject.set(pkey, []);
      byProject.get(pkey)!.push(sess);
    }
  }
  return { primaryGroups: buildPrimary(byPrimary), projectGroups: buildProjectGroups(byProject) };
}

// The "by label" grouping, shared by the session panel's render AND keyboard
// order (visualOrder) so Ctrl+J/K walks exactly what's on screen: manual-label
// groups first (label sort order), then per-project groups for unlabeled
// sessions (projects are auto-derived labels; biggest first, "other" last),
// newest-activity first within every group.
export function groupSessionsForLabelView(
  items: InboxSession[],
  buckets: Record<string, BucketItem>,
  bucketByConv: Record<string, string | undefined>,
): {
  labelGroups: Array<{ bucket: BucketItem; items: InboxSession[] }>;
  projectGroups: Array<{ name: string; items: InboxSession[] }>;
} {
  const { primaryGroups, projectGroups } = groupSessionsBy(
    items,
    // An assigned, non-archived bucket is the primary key; everything else falls
    // through to the project tier.
    (sess) => {
      const b = bucketByConv[sess._id];
      return b && buckets[b] && !buckets[b].archived_at ? b : null;
    },
    // Label groups follow the explicit label sort order, empties dropped.
    (byBucket) => sortLabels(buckets)
      .map((bucket) => ({ bucket, items: (byBucket.get(bucket._id) ?? []).sort(byActivity) }))
      .filter((g) => g.items.length > 0),
  );
  return { labelGroups: primaryGroups, projectGroups };
}

// "By plan" lens: the sibling of groupSessionsForLabelView, keyed on the
// session's plan instead of a manual label. EVERY plan gets its own section —
// even a plan of one — because this view's whole job is to show a plan's
// sessions together. This lens is the ONLY place the inbox groups by plan; the
// status view keeps every session in its status bucket. Sessions with no plan
// fall to project groups, exactly as unlabeled sessions do in the label view.
// Plans sort by size then label so the busiest run leads.
export function groupSessionsByPlan(
  items: InboxSession[],
): {
  planGroups: Array<{ key: string; label: string; items: InboxSession[] }>;
  projectGroups: Array<{ name: string; items: InboxSession[] }>;
} {
  const { primaryGroups, projectGroups } = groupSessionsBy(
    items,
    (sess) => sess.active_plan?.short_id ?? null,
    // All members of a plan share its label; derive it once from the first.
    (byPlan) => Array.from(byPlan.entries())
      .map(([key, list]) => ({ key, label: orchestrationGroupLabelOf(list[0])!, items: list.sort(byActivity) }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label)),
  );
  return { planGroups: primaryGroups, projectGroups };
}

// Thin InboxSession synthesized from a `favorites` list entry (listFavorites) for
// a kept session that isn't in the cache — an old favorite the inbox window never
// loaded. Enough for the shelf row + navigation; clicking hydrates the rest.
function synthesizeFavoriteRow(fav: any): InboxSession {
  return {
    _id: fav._id,
    session_id: fav.session_id ?? "",
    title: fav.title,
    updated_at: fav.updated_at ?? 0,
    message_count: fav.message_count ?? 0,
    agent_type: fav.agent_type ?? "claude_code",
    is_favorite: true,
    is_idle: true,
    has_pending: false,
  } as InboxSession;
}

// The Favorites set, driven off the authoritative `favorites` membership list
// (listFavorites) — NOT the per-row `is_favorite` flag. Two reasons:
//   • The flag arrives on cache rows via whichever channel synced them; web and
//     Convex deploy independently, so a row can be present without the flag set
//     (root of "badge says 13, shelf shows 0/9"). Membership is reliable.
//   • Deliberately ignores isSessionHidden — a favorite is dismissed/stashed from
//     the ACTIVE inbox as it ages; the shelf exists precisely to keep it.
// Prefers the rich cached row; falls back to a thin synthesized row so an old,
// never-loaded favorite still appears. Optional project chip inherited free.
export function selectFavoriteSessions(
  sessions: Record<string, InboxSession>,
  projectFilter?: string | null,
  favoritesList?: any[],
  filterExclude?: boolean,
): InboxSession[] {
  const matchesProject = (s: InboxSession) =>
    !projectFilter || (getProjectName(s.git_root, s.project_path) === projectFilter) !== !!filterExclude;
  const out: InboxSession[] = [];
  const seen = new Set<string>();
  for (const fav of favoritesList ?? []) {
    const id = fav?._id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const sess = sessions[id] ?? synthesizeFavoriteRow(fav);
    if (matchesProject(sess)) out.push(sess);
  }
  // Belt and suspenders: any cached row that DOES carry the flag but isn't in the
  // list yet (list still loading) still shows.
  for (const sess of Object.values(sessions)) {
    if (!sess.is_favorite || seen.has(sess._id)) continue;
    seen.add(sess._id);
    if (matchesProject(sess)) out.push(sess);
  }
  return out;
}

// Favorites order AS RENDERED: grouped by project (the shelf's default
// organization — answers "what is it about", not "what needs me now"), pinned
// favorites first. Reuses the bucket view's project grouping with no label tier
// so keyboard nav (visualOrder) walks exactly the on-screen order.
export function favoritesVisualOrder(
  sessions: Record<string, InboxSession>,
  projectFilter?: string | null,
  favoritesList?: any[],
  filterExclude?: boolean,
): InboxSession[] {
  const favs = selectFavoriteSessions(sessions, projectFilter, favoritesList, filterExclude);
  const pinned = favs.filter((s) => s.is_pinned).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const rest = favs.filter((s) => !s.is_pinned);
  const { projectGroups } = groupSessionsForLabelView(rest, {}, {});
  return [...pinned, ...projectGroups.flatMap((g) => g.items)];
}

// The panel→store bridge for schedule-derived nav data. Trigger rows live in a
// per-component Convex subscription (agentTasks.webList), so the panel
// publishes the projections nav needs: the absorbed set (status view) and the
// trigger view's ordered groups (session ids per trigger, roster order).
export type ScheduleNavSets = {
  absorbed: ReadonlySet<string>;
  triggerOrder?: Array<{ key: string; ids: string[] }>;
};

// Resolve the active inbox view mode from client UI state. Shared by the
// inboxViewMode getter and computeVisualOrder so every consumer agrees on
// which ordering is on screen.
export function resolveInboxViewMode(ui: { inbox_view_mode?: InboxViewMode; inbox_flat_view?: boolean } | undefined): InboxViewMode {
  return ui?.inbox_view_mode ?? (ui?.inbox_flat_view ? "time" : "grouped");
}

// Resolve the "show old sessions" toggle from client UI state. Shared by the
// panel, the sidebar/dashboard badges, keyboard nav and mobile so every
// consumer hides exactly the same rows. Reads ONLY inbox_show_old — the legacy
// show_old_sessions key (stale `true` values still linger in server client_state
// docs from its pre-LWW era) must stay unread forever, or the permanent
// cruft-mode bug resurrects.
export function resolveShowOld(ui: { inbox_show_old?: boolean } | undefined): boolean {
  return ui?.inbox_show_old ?? false;
}

// Resolve what the inbox opens on when no conversation is selected: the fleet
// board (default) or the chronological feed. Shared by the boot adoption below
// and the inbox stage so they can't land on different surfaces.
export function resolveInboxHome(ui: { inbox_home?: "board" | "feed" } | undefined): "board" | "feed" {
  return ui?.inbox_home ?? "board";
}

// A session's creation-time sort key for the "time" view: started_at, falling
// back to updated_at only when a session has no creation stamp.
const creationKey = (s: InboxSession) => s.started_at ?? s.updated_at ?? 0;

// Newest-first comparator for the two flat views. "recent" ranks by last
// activity (updated_at), so the list reshuffles as sessions work; "time" ranks
// by creation (started_at), a stable chronology. In "time", an optional
// manualOrder map overrides a row's key (drag-to-reorder); because those keys
// share the epoch-ms space of started_at, dragged and un-dragged rows sort on
// one continuous scale. The _id tiebreak keeps equal keys from jittering.
// Shared by computeVisualOrder (keyboard nav) and the panel's flat render so
// both agree on row order.
export function flatViewComparator(mode: "time" | "recent", manualOrder?: Record<string, number>) {
  return (a: InboxSession, b: InboxSession) => {
    if (mode === "recent") {
      return (b.updated_at ?? b.started_at ?? 0) - (a.updated_at ?? a.started_at ?? 0)
        || b._id.localeCompare(a._id);
    }
    const ka = manualOrder?.[a._id] ?? creationKey(a);
    const kb = manualOrder?.[b._id] ?? creationKey(b);
    return kb - ka || b._id.localeCompare(a._id);
  };
}

// Does a session pass the active project/bucket chip? ONE predicate behind both
// the panel's filterByChip and the flat-view keyboard order so a chip narrows
// the rendered list and Ctrl+J/K identically. A mid-create stub (non-Convex id)
// always passes the bucket chip — the session you just summoned inside a focused
// bucket must stay reachable before its assignment syncs. With `exclude` the
// chip inverts: matches are hidden, everything else shows (stubs still pass —
// an excluded label never files new sessions, see beginOptimisticSession).
export function chipMatchesSession(
  s: InboxSession,
  opts: { projectFilter?: string | null; bucketFilter?: string | null; exclude?: boolean; bucketByConv: Record<string, string | undefined> },
): boolean {
  // Mid-create stubs get the same carve-out on both branches: the session you
  // just summoned must stay reachable no matter which chip is focused — under
  // a project EXCLUDE, Ctrl+N from a focused session in that project would
  // otherwise navigate you onto a card the panel refuses to render.
  if (opts.projectFilter && isConvexId(s._id)) {
    const m = getProjectName(s.git_root, s.project_path) === opts.projectFilter;
    if (opts.exclude ? m : !m) return false;
  }
  if (opts.bucketFilter && isConvexId(s._id)) {
    const m = opts.bucketByConv[s._id] === opts.bucketFilter;
    if (opts.exclude ? m : !m) return false;
  }
  return true;
}

// Subagent/teammate rows never float at their own slot in a flat list — they
// render directly under their parent whenever the parent is in the list. The
// view comparator places a child wherever ITS OWN activity lands, which strands
// it between unrelated cards while its (recently-active) parent sorts far away
// — three ↳-styled rows adrift in the middle of the inbox. Children keep the
// comparator's relative order among siblings and follow chains (a child's own
// children ride along). A teammate whose lead didn't make the list stays where
// the sort put it — same "parentless renders flat" semantics as
// categorizeSessions; a parentless Task subagent never reaches here (see
// dropOrphanSubagents).
function hoistNestedUnderParent(list: InboxSession[]): InboxSession[] {
  const present = new Set(list.map((s) => s._id));
  const nestedHere = (s: InboxSession) => {
    const p = nestParentIdOf(s);
    return p && p !== s._id && present.has(p) ? p : null;
  };
  const kidsByParent = new Map<string, InboxSession[]>();
  for (const s of list) {
    const p = nestedHere(s);
    if (!p) continue;
    if (!kidsByParent.has(p)) kidsByParent.set(p, []);
    kidsByParent.get(p)!.push(s);
  }
  if (kidsByParent.size === 0) return list;
  const out: InboxSession[] = [];
  const emitted = new Set<string>();
  const emit = (s: InboxSession) => {
    if (emitted.has(s._id)) return;
    emitted.add(s._id);
    out.push(s);
    for (const kid of kidsByParent.get(s._id) ?? []) emit(kid);
  };
  for (const s of list) if (!nestedHere(s)) emit(s);
  // A parent-link cycle would leave its members un-emitted above (each waits on
  // the other) — append them in sort order rather than dropping rows.
  for (const s of list) emit(s);
  return out;
}

// The flat (time / recent) view's session list AS RENDERED — the single builder
// behind BOTH the panel's render and computeVisualOrder (keyboard nav), so the
// two can never drift. This is the crux of "Ctrl+J/K skips New Session cards
// outside grouped view": the grouped/bucket views render only the categorized
// status buckets, which deliberately drop never-engaged pre-warm blanks, but the
// flat views list EVERY non-hidden session (sortedSessions) — so nav has to walk
// that same full set or it steps over the blanks the panel is showing. Drops
// nested subagents when the toggle is off (always keeping the focused one),
// sorts by the view comparator, applies the chip predicate, then hoists each
// remaining subagent/teammate row under its parent (hoistNestedUnderParent).
// A Task subagent whose parent is NOT in the final list is dropped, exactly as
// categorizeSessions' isOrphanSubagent: it rides its parent (a hidden anchor's
// worker, a parent that aged out, was dismissed, or fails the chip). Left in,
// it floats at its own creation slot wearing the ↳ arrow and reads as a child
// of whatever unrelated card sorts above it. Teammates keep the "parentless
// renders flat" semantics (a real session someone may need to answer).
export function flatViewSessions(
  sortedSessions: InboxSession[],
  subsByParent: Map<string, InboxSession[]>,
  opts: {
    mode: "time" | "recent";
    showSubagents: boolean;
    focusedId?: string | null;
    manualOrder?: Record<string, number>;
    chipMatches?: (s: InboxSession) => boolean;
    // "recent" only: when set, hold the rows in this frozen id order instead of
    // the live updated_at sort (see recentFreezeOrder). Sessions absent from the
    // snapshot — new arrivals — fall to the end in live-recent order; removed
    // ones simply drop out. Both the panel render and computeVisualOrder pass it,
    // so the list the user navigates stops moving under the cursor.
    freezeOrder?: string[] | null;
  },
): InboxSession[] {
  const subIds = opts.showSubagents
    ? null
    : new Set(Array.from(subsByParent.values()).flat().map((s) => s._id));
  const list = subIds
    ? sortedSessions.filter((s) => !subIds.has(s._id) || s._id === opts.focusedId)
    : [...sortedSessions];
  list.sort(flatViewComparator(opts.mode, opts.mode === "time" ? opts.manualOrder : undefined));
  let ordered = list;
  if (opts.mode === "recent" && opts.freezeOrder?.length) {
    const rank = new Map(opts.freezeOrder.map((id, i) => [id, i]));
    const frozen = opts.freezeOrder.map((id) => list.find((s) => s._id === id)).filter(Boolean) as InboxSession[];
    const fresh = list.filter((s) => !rank.has(s._id)); // new since the snapshot, still in live order
    ordered = [...frozen, ...fresh];
  }
  return hoistNestedUnderParent(dropOrphanSubagents(opts.chipMatches ? ordered.filter(opts.chipMatches) : ordered, opts.focusedId));
}

// Drop Task subagents whose nest parent didn't make `list` (see flatViewSessions).
// The focused row always renders; a pinned one is an explicit "keep visible".
function dropOrphanSubagents(list: InboxSession[], focusedId?: string | null): InboxSession[] {
  const present = new Set(list.map((s) => s._id));
  return list.filter((s) => {
    if (s._id === focusedId || s.is_pinned || !isSubagentConversation(s)) return true;
    const p = nestParentIdOf(s);
    return !!p && p !== s._id && present.has(p);
  });
}

// The manual sort key to give a row dropped at `insertIndex` among `orderedKeys`
// — the effective keys (manual or creation) of the OTHER rows, newest-first,
// with the dragged row already removed. A midpoint between its new neighbors
// keeps a reorder to one write; at either end it steps a gap past the edge row.
// How long after the last Ctrl+J/K before the "recent" view's live updated_at
// sort resumes (recentFreezeOrder clears). Long enough to span a burst of j/k,
// short enough that the list feels live again the moment you stop.
const RECENT_FREEZE_THAW_MS = 1800;
let recentThawTimer: ReturnType<typeof setTimeout> | null = null;

const MANUAL_ORDER_GAP = 60_000; // 1 minute, in the started_at epoch-ms space
export function computeManualSortKey(orderedKeys: number[], insertIndex: number): number {
  const before = orderedKeys[insertIndex - 1]; // the row above (larger key)
  const after = orderedKeys[insertIndex];      // the row below (smaller key)
  if (before == null) return (after ?? 0) + MANUAL_ORDER_GAP; // dropped at the very top
  if (after == null) return before - MANUAL_ORDER_GAP;        // dropped at the very bottom
  return (before + after) / 2;
}

// The session order AS RENDERED, re-shuffled for the active view mode. Accepts
// the live store state or a mutative action draft, so keyboard nav (visualOrder)
// and the dismiss/kill advance-to-next paths (hideSessionInDraft, markKilling)
// all walk exactly the list the user is looking at. The grouped and bucket views
// render only the categorized status buckets, which drop never-engaged pre-warm
// blanks (currentSessionId keeps the one you're sitting on navigable); the flat
// (time / recent) views instead list EVERY non-hidden session — blanks included
// — so those branches build from the same flatViewSessions the panel renders, or
// Ctrl+J/K would step over the "New Session" cards on screen.
export function computeVisualOrder(state: {
  sessions: Record<string, InboxSession>;
  sessionsWithQueuedMessages: Set<string>;
  blockedReviveRequestedAt?: Record<string, number>;
  activeProjectFilter?: string | null;
  pendingMessages: Record<string, any[]>;
  currentSessionId?: string | null;
  pendingSessionCreates: Record<string, unknown>;
  activeBucketFilter?: string | null;
  chipFilterExclude?: boolean;
  bucketAssignments: Record<string, BucketAssignmentItem>;
  buckets: Record<string, BucketItem>;
  showFavorites?: boolean;
  favorites?: any[];
  liveInboxIds: Set<string>;
  teamInboxIds?: Set<string>;
  currentUser?: { _id?: string } | null;
  recentFreezeOrder?: string[] | null;
  collapsedSections?: Record<string, boolean>;
  // Ephemeral schedule projection published by GlobalSessionPanel (see
  // setScheduleNavSets) so grouped-mode nav skips sessions absorbed behind
  // TRIGGERS rows, and so trigger-mode nav walks the panel's trigger-group
  // order (trigger data lives in a component Convex subscription, never the
  // store). Null until the panel has schedule data.
  scheduleNavSets?: ScheduleNavSets | null;
  // Pending `cast decide` rows — with the viewer's own sessions they define the
  // status view's QUESTIONS section (liftQuestions). Optional for callers
  // (tests) that model no questions.
  sessionDecisions?: Record<string, SessionDecisionItem>;
  // Local answered/dismissed marks — same map the panel renders with, so nav
  // walks exactly the QUESTIONS section on screen.
  questionResolutions?: QuestionResolutions;
  clientState: { ui?: { inbox_view_mode?: InboxViewMode; inbox_flat_view?: boolean; inbox_manual_order?: Record<string, number>; show_subagents?: boolean; inbox_scope?: "mine" | "team"; inbox_show_old?: boolean } };
}): InboxSession[] {
  // Favorites view walks its own project-grouped order so Ctrl+J/K moves through
  // the shelf, not the active desk underneath it.
  if (state.showFavorites) {
    return favoritesVisualOrder(state.sessions, state.activeProjectFilter, state.favorites, state.chipFilterExclude);
  }
  const bucketByConv = convBucketMap(state.bucketAssignments);
  const mode = resolveInboxViewMode(state.clientState.ui);
  const collapsed = state.collapsedSections ?? {};
  // Hide "old" sessions before building ANY mode's order, exactly as the panel
  // does (partitionOldSessions over the same liveInboxIds / show_old flag), so
  // nav can never walk a row the render dropped. With "show old sessions" off a
  // stale (not-live) session is hidden on screen — Ctrl+J/K must skip it too, or
  // the highlight sits still while the selection jumps onto an off-screen old
  // card. This previously guarded only the flat views; grouped/bucket walked the
  // full session map and so stepped onto hidden old sessions.
  const focusedId = state.currentSessionId ?? null;
  // Scope FIRST, exactly as the panel does (filterInboxScope → partitionOldSessions),
  // so nav walks precisely the rows on screen: in team mode the team board's set,
  // in mine mode never a teammate row left in the shared cache. Team mode has no
  // "old" partition (the board is already a bounded set), matching the panel.
  const scope = state.clientState.ui?.inbox_scope ?? "mine";
  const scopedSessions = filterInboxScope(
    state.sessions,
    scope,
    state.currentUser?._id?.toString?.() ?? null,
    state.teamInboxIds,
    focusedId,
  );
  const { visibleSessions } = scope === "team"
    ? { visibleSessions: scopedSessions }
    : partitionOldSessions(
        scopedSessions,
        state.liveInboxIds,
        resolveShowOld(state.clientState.ui), // same flag the panel renders with — nav must walk exactly what's on screen
        focusedId,
      );
  if (mode === "time" || mode === "recent") {
    // The flat views render under a single collapsible "All" section; collapsing
    // it hides every card, so nav must walk nothing (else it lands on a hidden
    // row and the panel's auto-reveal effect force-expands the section).
    if (collapsed["all"]) return [];
    // Mirror the panel's flatList exactly (categorize the visible set, share
    // flatViewSessions) so nav walks every rendered row, blanks included.
    const { sorted, subsByParent } = categorizeSessions(
      visibleSessions,
      state.sessionsWithQueuedMessages,
      sessionsWithPendingSend(state.pendingMessages),
      { currentSessionId: focusedId, pendingCreateIds: new Set(Object.keys(state.pendingSessionCreates)), reviveRequestedAt: state.blockedReviveRequestedAt },
    );
    return flatViewSessions(sorted, subsByParent, {
      mode,
      showSubagents: state.clientState.ui?.show_subagents ?? true,
      focusedId,
      manualOrder: state.clientState.ui?.inbox_manual_order,
      freezeOrder: mode === "recent" ? state.recentFreezeOrder : null,
      chipMatches: (s) => chipMatchesSession(s, { projectFilter: state.activeProjectFilter, bucketFilter: state.activeBucketFilter, exclude: state.chipFilterExclude, bucketByConv }),
    });
  }
  // Grouped/bucket: the categorized status buckets over the SAME visible set, so
  // old sessions hidden from the render are skipped by nav too. The bucket branch
  // below splits pinned out and regroups the rest by label/project.
  const base = visualOrderSessions(visibleSessions, state.sessionsWithQueuedMessages, state.activeProjectFilter, sessionsWithPendingSend(state.pendingMessages), {
    currentSessionId: state.currentSessionId,
    pendingCreateIds: new Set(Object.keys(state.pendingSessionCreates)),
    bucketFilter: state.activeBucketFilter,
    filterExclude: state.chipFilterExclude,
    bucketByConv,
    collapsedSections: mode === "grouped" ? collapsed : undefined,
    absorbedIds: mode === "grouped" || mode === "bucket" || mode === "plan" ? state.scheduleNavSets?.absorbed : undefined,
    reviveRequestedAt: state.blockedReviveRequestedAt,
    // Only the status view renders QUESTIONS; the lenses dissolve it.
    questions: mode === "grouped"
      ? { decisions: state.sessionDecisions ?? {}, mine: filterInboxScope(state.sessions, "mine", state.currentUser?._id?.toString?.() ?? null), resolutions: state.questionResolutions }
      : undefined,
  });
  if (mode === "bucket") {
    const pinned = collapsed["pinned"] ? [] : base.filter((s) => s.is_pinned);
    const rest = base.filter((s) => !s.is_pinned);
    const { labelGroups, projectGroups } = groupSessionsForLabelView(rest, state.buckets, bucketByConv);
    return [
      ...pinned,
      ...labelGroups.flatMap((g) => (collapsed[`bucket_${g.bucket._id}`] ? [] : g.items)),
      ...projectGroups.flatMap((g) => (collapsed[`bucketproj_${g.name}`] ? [] : g.items)),
    ];
  }
  if (mode === "plan") {
    const pinned = collapsed["pinned"] ? [] : base.filter((s) => s.is_pinned);
    const rest = base.filter((s) => !s.is_pinned);
    const { planGroups, projectGroups } = groupSessionsByPlan(rest);
    return [
      ...pinned,
      ...planGroups.flatMap((g) => (collapsed[`plan_${g.key}`] ? [] : g.items)),
      ...projectGroups.flatMap((g) => (collapsed[`planproj_${g.name}`] ? [] : g.items)),
    ];
  }
  if (mode === "trigger") {
    // Trigger-first: walk the panel's published group order (the grouping needs
    // the trigger subscription only the panel has — see ScheduleNavSets). No
    // absorption in this mode: a trigger's sessions render under its row, so
    // nav walks them there. Two tiers only — no pinned/status chrome: pinned
    // sessions flow into groups or the project fallthrough like everything
    // else. Trigger groups don't collapse; the project tier does. Before the
    // panel publishes, fall back to base.
    const groups = state.scheduleNavSets?.triggerOrder;
    if (!groups) return base;
    const byId = new Map(base.map((s) => [s._id, s]));
    const walked: InboxSession[] = [];
    const grouped = new Set<string>();
    for (const g of groups) {
      for (const id of g.ids) {
        const sess = byId.get(id);
        if (sess && !grouped.has(id)) {
          grouped.add(id);
          walked.push(sess);
        }
      }
    }
    const { projectGroups } = groupSessionsForLabelView(
      base.filter((s) => !grouped.has(s._id)), {}, {},
    );
    return [
      ...walked,
      ...projectGroups.flatMap((g) => (collapsed[`trigproj_${g.name}`] ? [] : g.items)),
    ];
  }
  return base;
}

// Advance past a removed set: the first session below the current one in the
// on-screen order, wrapping to the top when the current row was last.
function nextSessionPastRemoved(ordered: InboxSession[], currentId: string, removed: ReadonlySet<string>): InboxSession | undefined {
  const idx = ordered.findIndex((s) => s._id === currentId);
  return ordered.slice(idx + 1).find((s) => !removed.has(s._id))
    ?? ordered.find((s) => !removed.has(s._id));
}

// Quick-create pre-warms a server conversation (and a daemon agent) per summon;
// without reuse, every abandoned summon strands an empty "New Session" row in
// the inbox forever. Reusing the existing blank session for the same
// project+agent makes repeated open/abandon cycles converge on ONE pre-warmed
// session — and resurfaces its draft. The server GC
// (cleanup.gcEmptyConversations) sweeps what reuse misses. The window stays
// well inside the GC's 24h grace so a reused id can never be a row the sweep
// is about to delete.
export const BLANK_SESSION_REUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

export function findReusableBlankSession(
  state: {
    sessions: Record<string, InboxSession>;
    pendingMessages: Record<string, any[]>;
    pendingSessionCreates: Record<string, Promise<string>>;
    currentUser?: any;
  },
  opts: { agentType: string; projectPath?: string; gitRoot?: string },
  now: number = Date.now(),
): string | null {
  const me = state.currentUser?._id?.toString?.();
  const wantPath = opts.projectPath || opts.gitRoot;
  if (!wantPath) return null;
  let best: InboxSession | null = null;
  let bestBorn = 0;
  for (const s of Object.values(state.sessions)) {
    if ((s.message_count ?? 0) !== 0 || s.has_pending) continue;
    // A local stub is ours by construction but only trustworthy while its
    // create is in flight; an orphaned stub (create failed) must not be reused.
    if (!isConvexId(s._id) && !state.pendingSessionCreates[s._id]) continue;
    if (state.pendingMessages[s._id]?.length) continue;
    // Dismissing OR stashing a blank REAPS it server-side (dispatch.applyPatches
    // tears down the pre-warm agent on the hide transition, then the conv is
    // deleted) — so a hidden row here is a corpse awaiting the ghost sweep,
    // never a reuse candidate. The next summon mints a fresh pre-warm instead.
    if (s.inbox_dismissed_at || s.inbox_stashed_at || s.is_pinned) continue;
    if (s.is_subagent || s.parent_conversation_id || s.worktree_name || s.workflow_run_id) continue;
    if (s.active_task || s.active_plan) continue;
    if (s.agent_type !== opts.agentType) continue;
    if ((s.project_path || s.git_root) !== wantPath) continue;
    // Teammate sessions can be injected into this cache — only reuse our own.
    if (s.user_id && (!me || s.user_id.toString() !== me)) continue;
    const born = s.started_at ?? s.updated_at ?? 0;
    if (!born || now - born > BLANK_SESSION_REUSE_WINDOW_MS) continue;
    if (born > bestBorn) {
      best = s;
      bestBorn = born;
    }
  }
  return best?._id ?? null;
}

// -- Store interface --

/** One live huddle as calls.getLiveRooms projects it. A room the viewer may
 *  not see the anchor of arrives `redacted` with no title — the room is still
 *  joinable (the team wall holds), only its name is withheld. */
export type LiveRoom = {
  room_key: string;
  team_id: string;
  /** The room's door, as a fact about the ROOM: what the lock glyph paints. */
  locked: boolean;
  /** The huddle turned transcription off (calls.setRoomTranscribeOff) — what
   *  keeps every seated client's auto-scribe from starting it again. */
  transcribe_off?: boolean;
  /** May THIS viewer walk in right now — the server's own authorizeRoom answer.
   *  A lock shuts the open door only, so a member of the room or a guest
   *  holding a live grant is still true here while `locked` is too. This, never
   *  `locked`, decides Join versus Knock. */
  can_join: boolean;
  redacted: boolean;
  title?: string;
  members: { user_id: string; user_name?: string; user_image?: string; muted?: boolean }[];
};

/** Someone waiting at the door of the room I'm in (calls.getRoomKnocks). */
export type RoomKnock = {
  from_user: string;
  from_name: string;
  from_image?: string;
  created_at: number;
};

// RegisteredCollectionSlots: every collection in CLIENT_SYNC_REGISTRY gets a
// typed `Record<string, any>` slot here by registration alone; the explicit
// fields below narrow the ones with a real row type.
interface InboxStoreState extends ChatSliceState, Omit<RegisteredCollectionSlots, keyof ChatSliceState> {
  sessions: Record<string, InboxSession>;
  pending: Record<string, PendingEntry>;
  currentSessionId: string | null;
  // This client's OWN last-focused conversation — persisted locally (IDB meta),
  // never synced. The boot-restore source of truth; see
  // recordCurrentConversationPointer for why it exists alongside the per-user
  // synced pointer.
  lastFocusedConversationId: string | null;
  showDismissed: boolean;
  collapsedSections: Record<string, boolean>;
  // "recent" view only: a frozen snapshot of the row order, set while the user is
  // navigating with Ctrl+J/K and cleared after a short idle. Recent sorts by
  // updated_at, which working sessions bump every heartbeat — without this the
  // list re-sorts under the cursor and j/k steps through a moving target. null =
  // live (re-sorts freely). Ephemeral: never persisted or synced.
  recentFreezeOrder: string[] | null;
  // Schedule projection for keyboard nav (standing sessions + runs collapsed
  // under a schedule group row, and the trigger view's group order), published
  // by GlobalSessionPanel from its agentTasks.webList subscription. Ephemeral:
  // never persisted or synced.
  scheduleNavSets: ScheduleNavSets | null;
  // One-shot request to open the schedule strip above a conversation, published
  // by schedule-surface clicks (dock rows, bars under cards) so navigating FROM
  // a schedule lands with the prompt already visible. Nonce-keyed: the strip
  // consumes each nonce at most once, so a stale request is inert. Ephemeral.
  scheduleStripExpand: { convId: string; nonce: number } | null;
  // One-shot composer seed from a `?prefill=` deep link, published by the
  // /conversation/<id> page before it redirects to the inbox. It cannot ride the
  // URL: that redirect drops the query, and the inbox canonicalizes the address
  // again once the session resolves. Keyed by conversation so only that
  // session's composer takes it, and consumed there at most once. Ephemeral.
  composerPrefill: { convId: string; text: string } | null;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;
  renamingSessionId: string | null;
  // Kill+restarts in flight, keyed by conversation id → startedAt. Written by
  // useSessionRestart so surfaces beyond the open conversation (the inbox row)
  // can show the recovery. Ephemeral — never persisted; readers must treat an
  // entry older than the ~2m give-up budget as expired, because a restart
  // started then navigated away from has no live owner to clear it.
  restartingSessions: Record<string, number>;
  // Device moves in flight ("Run here" / "Move to remote Mac"), keyed by
  // conversation id. Written by useMoveSessionToDevice (DeviceBadge) so the
  // conversation header can narrate the move like a restart. Ephemeral — never
  // persisted; readers expire entries by age since a move navigated away from
  // has no live owner to clear it.
  movingSessions: Record<string, { started_at: number; to_device_id: string; to_remote: boolean; to_label: string; error?: string }>;
  pendingScrollToMessageId: string | null;
  // The bookmarked message's known timestamp, carried alongside the scroll
  // target so the conversation view can open the window AROUND it on first
  // paint (the prefetched getMessagesAroundTimestamp is centered on this same
  // value) instead of loading the live tail first and jumping afterward.
  pendingScrollToMessageTimestamp: number | null;
  pendingHighlightQuery: string | null;
  showMySessions: boolean;
  setShowMySessions: (show: boolean) => void;
  // The session-list panel is showing the Favorites view (a long-term kept set,
  // grouped by project) instead of the active inbox. Reuses the same panel,
  // rows, keyboard nav and project filter — only the source set and grouping
  // differ. Mutually exclusive with the feed (showMySessions).
  showFavorites: boolean;
  setShowFavorites: (show: boolean) => void;
  // Ids the LIVE listInboxSessions subscription (show_all:false) currently
  // returns — i.e. the server's authoritative "recent" set. The never-prune
  // sessions cache also holds "old" rows backfilled by the completeness crawl
  // (which disables cluster-hiding), so "old" can't be a server flag; it's
  // exactly the cached top-level sessions NOT in this set. The "show old
  // sessions" toggle filters against it client-side (see GlobalSessionPanel).
  liveInboxIds: Set<string>;
  // Team-mode active set: the ids the team board is currently showing (own +
  // teammates' team-visible), fed by the listTeamInboxSessions subscription.
  // The analogue of liveInboxIds for inbox_scope "team" — the panel gates the
  // visible set on this instead of liveInboxIds while team mode is on. Empty in
  // "mine" mode. Rows themselves live in the shared (never-prune) sessions cache;
  // this is only the membership set for the current team view.
  teamInboxIds: Set<string>;
  // Persisted twin of liveInboxIds (plain array: the native store JSON-serializes
  // meta blobs and generic hydration merges don't understand Sets). Written only
  // by setLiveInboxIds, hydrated manually at boot into liveInboxIds — so the FIRST
  // painted frame already renders the last-known authoritative set instead of
  // flashing the whole never-prune cache until the live payload lands.
  liveInboxIdList: string[];
  // Persisted twin of teamInboxIds, keyed by the team it belongs to. Seeded at
  // boot (seedTeamInboxIdsFromCache) ONLY when the client is in team scope and
  // the active team matches — so the first painted team-board frame shows the
  // last-known membership instead of falling back to the "mine" filter for a
  // second until the team subscription answers.
  teamInboxIdSnapshot: { team_id: string | null; ids: string[] } | null;
  // Replace the authoritative active-inbox set (both twins) from a server
  // payload. sync(): persists, never dispatches — this is server truth.
  setLiveInboxIds: (ids: string[]) => void;
  // Team-mode analogue; teamId keys the persisted snapshot.
  setTeamInboxIds: (ids: string[], teamId: string | null) => void;
  // Clear stale ownership claims from cached foreign-run rows the live payload
  // no longer returns. Disowning is communicated only by ABSENCE (the server
  // stops returning the row rather than pushing an updated one), so the
  // never-prune cache keeps the last-seen version claiming owned_by_me forever —
  // which defeats the "mine" scope filter and, with show-old on, renders the
  // disowned session as a normal inbox card. Run on EVERY live payload.
  reconcileDisownedSessions: (ids: string[]) => void;
  // "Show old sessions" — a sticky per-user view preference. Lives in
  // clientState.ui.inbox_show_old (read via resolveShowOld) so it survives
  // reloads and follows the user across devices. It was ephemeral for a while:
  // the ORIGINAL synced flag merged local_wins, so one browse click became a
  // permanent all-clients cruft mode (the OFF could never propagate). The key
  // is now stamped per-key LWW (STAMPED_UI_KEYS + mergeStampedBagLww), so
  // turning it off anywhere turns it off everywhere — sticky without stuck.
  setShowOldSessions: (show: boolean) => void;
  // MRU "entered at" per session — bumped only when you switch INTO a session.
  // Drives the Tab switcher order + message eviction. Kept separate from
  // _seenUpToAt so the current session is always strictly the most recent (no
  // ties with the session you just left). Persisted so it survives a refresh.
  _lastViewedAt: Record<string, number>;
  // "Seen up to" per session — advanced only when you LEAVE a session. The
  // Slack-style "New" divider sits above the first message newer than this.
  // Because it only moves on leave, it stays constant for the whole visit, so
  // the line holds its position while you read. Persisted so reopening the app
  // still shows what arrived while you were gone.
  _seenUpToAt: Record<string, number>;
  // "Seen message_count" per session — the conversation's message_count at the
  // moment you LEFT it (same leave-time semantics as _seenUpToAt). Powers the
  // unread badge on branch chips, where the fork's own messages aren't loaded:
  // unread = message_count - max(seenCount, fork_copied). Absent (never opened)
  // falls back to fork_copied, so the whole post-fork branch reads as unread.
  _seenMessageCount: Record<string, number>;

  messages: Record<string, Message[]>;
  pendingMessages: Record<string, Message[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;
  userMessages: Record<string, UserMessage[]>;

  clientState: ClientState;
  clientStateInitialized: boolean;

  drafts: Record<string, Record<string, any>>;

  // Queued messages (Ctrl+Enter while the agent is busy): the texts waiting to
  // be auto-sent when the agent next reaches "needs input". Persisted exactly
  // like drafts (registered in CLIENT_SYNC_REGISTRY) so they survive navigation
  // and reload — a user message must never be lost. Keyed by conversation id.
  queuedMessages: Record<string, string[]>;

  // -- Inline review (quote / comment on assistant message blocks) --
  // Ephemeral UI state: which message is in keyboard/inline-review mode, the
  // highlighted block within it, and the batch of pending comments per
  // conversation. Never synced or persisted — survives session switches in
  // memory, resets on reload (the right lifetime for an in-progress batch).
  reviewMessageId: string | null;
  reviewActiveBlock: number;
  reviewEditingId: string | null;
  reviewComments: Record<string, PendingComment[]>;
  setReviewTarget: (messageId: string | null, blockIndex?: number) => void;
  setReviewActiveBlock: (blockIndex: number) => void;
  setReviewEditingId: (id: string | null) => void;
  addReviewComment: (conversationId: string, comment: PendingComment) => void;
  commitReviewComment: (conversationId: string, id: string, body: string) => void;
  removeReviewComment: (conversationId: string, id: string) => void;
  clearReviewComments: (conversationId: string) => void;
  getReviewComments: (conversationId: string) => PendingComment[];

  // ── Comment rail (ephemeral UI; teammate comment thread on the right) ──
  commentRailAnchor: string | null;           // a pending anchored thread (messageId) to focus
  commentRailNonce: number;                   // bump to re-trigger focus/scroll to the anchor
  commentRailWidth: Record<string, number>;   // reserved width (px) per conversation; published by the rail, read by the layout
  setCommentRailOpen: (open: boolean | null) => void;
  openCommentThread: (messageId?: string | null) => void;
  closeCommentRail: () => void;
  setCommentRailWidth: (conversationId: string, w: number) => void;

  // ── Threads page: per-card open state (ephemeral UI, raw set — the same
  // class as the palette toggle). Keyed by card id; the resolution rules
  // (default-open on unread, a user collapse holding until newer unread)
  // live in lib/threadCards. ──
  threadCardOpen: Record<string, ThreadCardOpenEntry>;
  patchThreadCardOpen: (patch: Record<string, ThreadCardOpenEntry>) => void;

  currentConversation: CurrentConversationContext;
  isolatedWorktreeMode: boolean;
  setIsolatedWorktreeMode: (val: boolean) => void;

  // -- Unified command palette --
  palette: { open: boolean; targets: any[]; targetType: 'task' | 'doc' | 'plan' | 'session' | null; initialMode: string; initialQuery?: string; pick?: PalettePick };
  // `pick` opens the palette as an entity chooser (see lib/palettePick.ts):
  // the caller's title/extras on top, the usual recents + search below, and
  // the choice returned through `pick.onPick` instead of navigating.
  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan' | 'session'; mode?: string; initialQuery?: string; pick?: PalettePick }) => void;
  closePalette: () => void;
  togglePalette: () => void;

  // -- New-session compose popup --
  // The floating new-session popup (ComposeView), shown as an in-app overlay —
  // the same surface the command palette's compose mode uses. Every "New Session"
  // affordance opens this. `initialQuery` pre-fills the composer (e.g. doc-review
  // "New agent"); `nonce` bumps each open so the overlay remounts on a fresh
  // blank session. `context` lets a caller seed the new session's project when
  // there's no current conversation to inherit it from — doc review passes the
  // doc's own project so the new agent spawns where the doc lives (without it
  // ComposeView falls back to currentConversation/recents, which are empty on the
  // docs page → a pathless start the daemon defaults to $HOME). Ephemeral UI
  // state (raw set), like the palette toggle.
  compose: { open: boolean; initialQuery?: string; context?: { projectPath?: string; gitRoot?: string }; nonce: number };
  openCompose: (initialQuery?: string, context?: { projectPath?: string; gitRoot?: string }) => void;
  closeCompose: () => void;

  // -- Create modal --
  createModal: CreateModalKind | null;
  /** Fields the create modal should open pre-filled with — how a scoped
   *  surface (a project's task list) makes "new task" mean "new task here". */
  createModalDefaults: { project_id?: string; plan_id?: string } | null;
  openCreateModal: (type: CreateModalKind, defaults?: { project_id?: string; plan_id?: string }) => void;
  closeCreateModal: () => void;

  // -- Close-guard: one shared dialog for "close a parent with open subtasks".
  // Any surface (list, kanban, palette, plan board, detail) sets this via
  // closeTaskWithGuard; a single CloseGuardDialog in DashboardLayout renders it.
  taskCloseGuard: { shortId: string; status: 'done' | 'dropped'; open: TaskItem[]; statusId?: string } | null;
  setTaskCloseGuard: (g: { shortId: string; status: 'done' | 'dropped'; open: TaskItem[]; statusId?: string } | null) => void;

  // -- Fork navigation --
  // Forks are first-class conversations; we navigate to them by URL. No overlay state.
  optimisticForkChildren: ForkChild[];

  // -- Dispatch (provided by middleware) --
  _setDispatch: (
    fn: ((action: string, args: any, patches?: any, result?: any) => Promise<any>) | null,
    options?: { owner?: object },
  ) => void;
  _clearDispatch: (owner: object) => void;
  _setDispatchError: (fn: (action: string, error: unknown, args?: unknown) => void) => void;
  _setStorageHealth: (fn: ((healthy: boolean, elapsedMs: number) => void) | null) => void;
  _dispatch: (action: string, args: any, patches?: any, result?: any) => Promise<any>;
  _handleReceiptRejection: (
    actionName: string,
    localResult: unknown,
  ) => string[] | false;
  _handleReceiptAcknowledgement: (
    actionName: string,
    continuation: DurableCreateContinuation,
    serverResult: unknown,
    commandId: string,
  ) => void;
  _clearPostCreateBucketIntent: (conversationId: string, bucketId: string) => void;
  dispatchErrors: number;
  // True while durable IndexedDB writes exceed the enqueue watchdog. Delivery
  // is unaffected; the banner tells the user durability is degraded.
  storageDegraded: boolean;
  // Last PERMANENT dispatch rejection (server ran the write and refused it) —
  // ephemeral, raw-set by the dispatch error handler; a platform-specific
  // surface (web: toast bridge in providers.tsx) turns it into user feedback.
  // Transient failures never land here: the outbox keeps re-driving those.
  lastDispatchFailure: { action: string; args: unknown; message: string; at: number } | null;

  // -- Wrapped actions (middleware creates aliases from do_* -> *) --
  stashSession: (id: string) => void;
  killSession: (id: string) => void;
  killSessions: (ids: string[]) => void;
  markSessionsDismissed: (ids: string[]) => void;
  markBlockedAcknowledged: (ids: string[]) => void;
  markBlockedReviveRequested: (ids: string[]) => void;
  clearBlockedReviveRequested: (ids: string[]) => void;
  applyDismissedReconcile: (entries: { _id: string; inbox_dismissed_at: number | null }[], final: boolean) => void;
  applyStashedReconcile: (entries: { _id: string; inbox_stashed_at: number | null }[], final: boolean) => void;
  restoreSession: (id: string) => void;
  deferSession: (id: string) => void;
  dormantSession: (id: string) => void;
  pinSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  switchProject: (convId: string, path: string) => void;
  patchConversation: (id: string, fields: Record<string, any>) => void;
  flushResolvedSessionFields: (id: string, fields: Record<string, any>) => void;
  applyUndoPatches: (patches: Record<string, Record<string, Record<string, any>>>) => void;
  toggleFavorite: (id: string) => void;
  setPrivacy: (id: string, isPrivate: boolean) => void;
  setTeamVisibility: (id: string, visibility: "summary" | "full" | null) => void;
  toggleBookmark: (conversationId: string, messageId: string) => void;
  setMyStatus: (status: "available" | "busy" | "away") => void;
  setWalkiePref: (pref: "team" | "off") => void;
  snoozeWalkie: (until: number) => number;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  sendMessage: (convId: string, content: string, imageIds?: string[], clientId?: string) => void;
  resumeSession: (convId: string) => Promise<any>;
  sendEscape: (convId: string) => void;
  convCommand: (convId: string, command: string, extraArgs?: Record<string, any>, optimistic?: Record<string, any>) => Promise<any>;
  createSession: (opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string; linked_object?: { type: string; id: string }; model?: string; effort?: string; isolated?: boolean; worktree_name?: string; stable_mode?: string; stable_exclude?: string[]; target_device_id?: string }) => Promise<any>;
  // Create the server session for a DEFERRED stub, sourcing project + agent from
  // the LIVE stub row (the new-session pickers write it via updateSessionProject /
  // setConversationAgent) rather than a begin-time closure. This is what makes a
  // project/agent switch made BEFORE the first send actually stick. Also stamps
  // the live `isolatedWorktreeMode` so the "isolated worktree" toggle takes effect
  // at create. `fallback` covers a stub that was somehow never seeded. Pairs with
  // beginOptimisticSession({ deferCreate })'s materialize() AND the in-app
  // self-heal create (ensureSessionCreated routes through it too).
  createSessionFromStub: (stubId: string, fallback?: { agentType?: string; projectPath?: string; gitRoot?: string }) => Promise<any>;
  // The one true path for optimistically creating a session: stubs a local
  // conversation synchronously and rekeys it to the real Convex id when `create`
  // resolves. Every new-session entry point funnels through this so a first
  // message can never be left non-optimistic. Returns the stub id (navigate to it
  // immediately) and the in-flight create promise (await for the real id).
  // `reuse` makes repeated summons converge on the existing blank session for the
  // same project+agent instead of minting (and pre-warming) a new conversation
  // per summon — see findReusableBlankSession.
  // `deferCreate` seeds the local stub (so the popup can render + bind a draft)
  // but does NOT fire `create` until the returned `materialize()` runs — the
  // new-session popup uses it so merely opening doesn't strand a conversation on
  // Escape. `materialize()` is idempotent and returns the same `ready` promise.
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; reuse?: boolean; deferCreate?: boolean; create: (stubId: string) => Promise<string> }) => { stubId: string; ready: Promise<string>; materialize: () => Promise<string> };
  // Verified ghost removal: hard-drop cached session rows the server confirmed
  // deleted (the empty-conversation GC). Plants the exclude pending entries that
  // authorize the IDB row delete and block crawl re-adds.
  pruneGhostSessions: (ids: string[]) => void;
  // Receiver for the cross-window gesture bridge — see gestureBridge.ts.
  applyGestureBridge: (msg: GestureMessage) => void;
  pruneFeedEntities: (collection: FeedCollection, ids: string[]) => void;
  clearFeedExcludes: (collection: FeedCollection, ids: string[]) => void;
  markServerDeleted: (convId: string) => void;
  // -- Sync-log write acks (docs/architecture/sync-log-migration.md D8) --
  stampSyncAck: (patches: any, ack: Array<{ scope_key: string; position: number }>, sentAt: number) => void;
  retireAckedPending: (scopeKey: string, upTo: number) => void;
  // Scope lifecycle (D5): purge a revoked team's rows from the workspace-scoped
  // collections and drop its log cursor.
  purgeTeamScopeRows: (teamId: string) => void;
  clearSyncMeta: (key: string) => void;
  clearCrawlMetaForScope: (scopeKey: string) => void;

  // -- Generic sync --
  syncTable: (field: string, incoming: any, opts?: SyncOpts) => void;
  syncRecord: (field: string, id: string, record: any) => void;
  // The detail query answered null for a doc we have cached: it was deleted or
  // access was revoked — drop the cached body so the page shows "not found"
  // instead of stale content forever.
  dropDocDetail: (id: string) => void;
  // Local-first clear of a row's "assigned to you" ping (paired with the
  // ackSessionAssignment mutation, which the caller fires separately).
  clearAssignedPing: (conversationId: string) => void;
  syncOverlay: (field: string, overlayById: Record<string, Record<string, any>>) => void;
  syncMentionIndex: (kind: "tasks" | "docs" | "plans", items: any[]) => void;
  // -- Incremental-sync watermark (IDB-persisted, keyed by "<namespace>:<wsKey>") --
  // The durable memory that makes sync local-first: `cursor` is the highest
  // `updated_at` we've synced for a workspace (the delta channels resume from it
  // instead of re-snapshotting), and `backfilledAt` records when the full
  // reconcile crawl last completed (so it runs once, then incrementally — not a
  // 4,529-row sweep on every launch). See useSyncTasks / reconcileCrawl.
  syncMeta: Record<string, { cursor?: number; backfilledAt?: number; resumeCursor?: string | null; resumeAt?: number }>;
  recordSyncMeta: (key: string, patch: { cursor?: number; backfilledAt?: number; resumeCursor?: string | null; resumeAt?: number }) => void;
  // -- Team activity-feed cache (IDB-persisted, keyed by team+dir) --
  feedConversations: Record<string, any[]>;
  feedHasMore: Record<string, boolean>;
  // Server-issued continuation cursor per feed key: string = resume point for
  // the next older page, null = the server confirmed true end-of-history,
  // absent = unknown (fall back to the oldest cached row).
  feedCursors: Record<string, string | null>;
  mergeFeedConversations: (key: string, convs: any[]) => void;
  setFeedHasMore: (key: string, hasMore: boolean) => void;
  setFeedCursor: (key: string, cursor: string | null) => void;
  sortedSessions: () => InboxSession[];
  visualOrder: () => InboxSession[];

  // -- Navigation --
  advanceToNext: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  // Snapshot the live "recent" order on the first Ctrl+J/K and re-arm a thaw
  // timer on each; a no-op outside recent mode. Keeps the list from re-sorting
  // mid-navigation. See recentFreezeOrder.
  freezeRecentForNav: () => void;
  thawRecentOrder: () => void;
  setCurrentSession: (id: string, source?: ViewNavSource) => void;
  clearSelection: () => void;
  toggleCollapsedSection: (key: string) => void;
  // Publish the schedule projection (standing sessions, runs grouped under a
  // schedule row) for keyboard nav. Ephemeral raw-set state — the schedule data
  // itself lives in the agentTasks.webList Convex subscription, never the store.
  setScheduleNavSets: (sets: ScheduleNavSets | null) => void;
  setScheduleStripExpand: (req: { convId: string; nonce: number } | null) => void;
  setComposerPrefill: (req: { convId: string; text: string } | null) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  preloadForkSessions: (forks: ForkChild[], forkedFrom?: string) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  setSessionTargetDevice: (id: string, deviceId: string | null) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  setConversationAgent: (id: string, agentType: string) => void;
  // Local-only optimistic model/effort stamp (header picker / new-session
  // picker). The durable value arrives via the server: rollup echo for
  // in-place switches, reconfigure/create stamps for launches.
  setConversationModel: (id: string, opts: { model?: string | null; effort?: string | null }) => void;
  // Stamp per-session stable-context launch prefs on a NEW-session stub row
  // (local-only; folded into createSession by createSessionFromStub, same
  // lifecycle as the model/effort stamps). mode: "team" | "solo" | "off";
  // exclude: conversation ids dropped from the injected feed.
  setStableContextPrefs: (id: string, prefs: { mode?: string | null; exclude?: string[] | null }) => void;
  navigateToSession: (id: string, source?: ViewNavSource) => void;
  requestNavigate: (
    id: string,
    opts?: {
      scrollToMessageId?: string | null;
      scrollToMessageTimestamp?: number | null;
      highlightQuery?: string | null;
      showMySessions?: boolean;
      source?: ViewNavSource;
    },
  ) => void;
  touchMru: (id: string) => void;
  markKilling: (id: string) => void;

  // -- Message actions --
  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => void;
  mergeMessages: (convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) => void;
  applyTailMessages: (convId: string, anchorTs: number, msgs: Message[], lastTimestamp: number | null) => void;
  setUserMessages: (convId: string, msgs: UserMessage[]) => void;
  addOptimisticMessage: (convId: string, content: string, images?: Array<OptimisticImage>, clientId?: string) => string;
  markOptimisticAsQueued: (convId: string, content: string) => void;
  markOptimisticAsFailed: (convId: string, clientId: string) => void;
  removeOptimisticMessage: (convId: string, clientId: string) => void;
  // Swap an optimistic message's still-uploading images for their resolved
  // server records (drops the spinner) once a backgrounded upload completes.
  resolvePendingUploads: (convId: string, clientId: string, images: Array<OptimisticImage>) => void;
  // Record the exact bytes the durable send dispatched for a pending row (see
  // Message._dispatchContent) so redrives replay them instead of re-deriving.
  stampPendingDispatchContent: (convId: string, clientId: string, dispatchContent: string) => void;
  setPagination: (convId: string, update: Partial<PaginationState>) => void;
  initPagination: (convId: string) => void;

  // -- Metadata --
  setCurrentConversation: (ctx: CurrentConversationContext) => void;
  clearCurrentConversation: () => void;

  // -- Drafts --
  setDraft: (id: string, fields: Record<string, any>) => void;
  setSessionHasDraft: (id: string, has: boolean) => void;
  getDraft: (id: string) => Record<string, any> | undefined;
  moveDraft: (fromId: string, toId: string) => void;
  clearDraft: (id: string) => void;
  clearDraftFinal: (id: string) => void;

  // -- Queued messages --
  getQueuedMessages: (id: string) => string[];
  setQueuedMessagesFor: (id: string, list: string[]) => void;

  // -- Session ID resolution --
  resolveSessionId: (sessionId: string, convexId: string) => void;
  getConvexId: (id: string) => string | undefined;
  resolveLiveSessionId: (id: string) => string;
  // Resolve a (possibly still-being-created) session to its real Convex id,
  // awaiting the in-flight createSession dispatch / polling the rekey. Usable
  // from non-React code (background senders) since it only reads store state.
  awaitConvexId: (id: string) => Promise<string>;
  // In-memory map: stub id → in-flight createSession dispatch promise. Lets
  // consumers await rekey directly instead of polling. Not synced/persisted.
  pendingSessionCreates: Record<string, Promise<string>>;
  trackSessionCreate: (stubId: string, promise: Promise<string>) => void;
  awaitSessionCreate: (stubId: string) => Promise<string> | undefined;
  // Re-create a stub whose createSession was given up (outbox cap / lost to a
  // reload), reusing the stub row's own fields. Idempotent client- and
  // server-side; returns the resolved real id.
  ensureSessionCreated: (id: string) => Promise<string>;
  // Re-create a stranded stub AND re-send the messages queued into it while it
  // had no server conversation. Returns the real id, or null if the create
  // still hasn't landed. Drives the heal-on-load sweep.
  healStrandedStub: (stubId: string) => Promise<string | null>;
  // Hydration safety net for the tiny crash window after a stub rekeyed but
  // before its first-message fallback could enqueue. Safe on every boot because
  // sendMessage is idempotent on the persisted client id.
  redrivePendingMessages: () => void;
  resumePostCreateSessionIntents: () => void;

  // -- Fork navigation --
  addOptimisticFork: (fork: ForkChild) => void;
  pruneOptimisticForks: (serverIds: Set<string>) => void;
  resolveForkSessionId: (sessionId: string, convexId: string) => void;
  // Roll back a locally seeded fork stub after the server fork failed: drops the
  // stub's rows and returns focus to the parent conversation.
  discardForkStub: (stubId: string, parentId?: string) => void;

  // -- Client prefs (mutative actions -> auto-dispatch) --
  updateClientUI: (partial: Partial<ClientUI>) => void;
  updateClientLayout: (key: keyof ClientLayouts, value: any) => void;
  updateClientDismissed: (key: keyof ClientDismissed, value: any) => void;
  updateClientTips: (partial: Partial<ClientTips>) => void;

  // -- Saved views --
  createSavedView: (opts: { name: string; page: "tasks" | "docs" | "plans" | "workspace"; prefs: any; shared?: boolean; icon?: string; client_key?: string; team_id?: string }) => any;
  updateSavedView: (id: string, fields: Record<string, any>) => void;
  deleteSavedView: (id: string) => void;

  // -- Tabs --
  tabs: AppTab[];
  activeTabId: string | null;
  openTab: (opts: { path: string; title: string; sessionId?: string; makeActive?: boolean }) => string;
  closeTab: (id: string) => void;
  switchTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<AppTab>) => void;
  saveCurrentTabState: (patch?: Partial<AppTab>) => void;

  // -- Recent projects cache --
  recentProjects: Array<{ path: string; count: number; lastActive: number }>;
  setRecentProjects: (projects: Array<{ path: string; count: number; lastActive: number }>) => void;

  // Per-machine folder lists (the device-scoped getRecentProjectPaths results),
  // so the new-session picker paints a machine's folders from cache instantly
  // instead of waiting on the scoped query round-trip. Safe to serve stale: a
  // device's cache only ever holds that same device's prior answer, so it can
  // never offer a path the target machine lacks.
  recentProjectsByDevice: Record<string, Array<{ path: string; count: number; lastActive: number; suggested?: boolean }>>;
  setRecentProjectsForDevice: (deviceId: string, projects: Array<{ path: string; count: number; lastActive: number; suggested?: boolean }>) => void;

  // -- Machine roster (non-persisted; mirrors the live devices query) --
  // Only exists so the create path can re-check, at the moment it fires, whether
  // a picked machine is still the one routing would choose anyway. Deliberately
  // NOT persisted: a stale roster from a previous session would make that check
  // worse than not having it.
  machineRoster: MachineCandidate[];
  // True once a LIVE listDevices push has landed this page load. The persisted
  // roster serves display at boot; the path-seeding gate (pathOnMyMachines)
  // reads the roster only when this is true, so a stale cache can never veto
  // a freshly cloned path.
  machineRosterLive: boolean;
  setMachineRoster: (devices: MachineCandidate[]) => void;

  // -- Tier-2 store-fed surfaces (see clientSyncRegistry) --
  // Crosstalk graph snapshot (sessionThreads.listSessionThreads).
  sessionThreads: { links: any[]; nodes: any[] } | null;
  // Aggregate fleet CPU/memory samples over the last 2h.
  sessionMetricsAggregate: Array<{ collected_at: number; cpu: number; memory: number; pid_count: number }> | null;
  // Trigger verbs. Local-first: flip the agent_tasks row on the draft, ride a
  // named dispatch side effect to the real mutation.
  triggerAction: (
    taskId: string,
    verb: "pause" | "resume" | "runNow" | "cancel" | "reactivate",
  ) => void;
  deleteTrigger: (taskId: string) => void;
  // Remove rows from a NON-localFirst collection without planting tombstones —
  // for transient per-scope collections whose server answer of "nothing" is
  // itself the deletion (pendingMessageStatus). A localFirst collection must
  // delete through an action() so the exclude tombstone lands.
  dropRows: (key: string, ids: string[]) => void;

  // -- Active project scope (non-persisted, resets on reload) --
  activeProjectPath: string | null;
  activeProjectFilter: string | null;
  setActiveProjectFilter: (name: string | null, path?: string | null, exclude?: boolean) => void;
  // Whether the ONE active chip (project or bucket) is in exclude mode —
  // "everything but this" instead of "only this". Click toggles include;
  // exclude is entered only via ⌥/Alt-click or the chip's context menu.
  chipFilterExclude: boolean;

  // -- Capability library --
  // What every machine reports it has (fleet mirror, server truth).
  capabilityState: Record<string, any>;
  // What the user wants where (bindings). Optimistic: setCapabilityBinding
  // writes the draft and rides dispatch to the named server side effect, which
  // calls the same upsert the CLI does.
  capabilityBindings: Record<string, CapabilityBindingRow>;
  setCapabilityBinding: (opts: {
    capability_slug: string;
    scope_kind: string;
    scope_key?: string;
    enabled: boolean;
    team_id?: string;
    client_key?: string;
  }) => void;

  // -- Decision queue (cast decide) --
  sessionDecisions: Record<string, SessionDecisionItem>;
  // Resolve a decision locally (status flips instantly; patch rides the
  // outbox) and, for answers, send the chosen option into the session as a
  // normal user message. `text` is the free-form escape hatch.
  answerDecision: (decisionId: string, answer: { index?: number; text?: string } | { dismiss: true }) => void;
  // Local marks that a session's open AskUserQuestion / permission ask was
  // handled here (answered, dismissed, or evicted). Ephemeral by design — not
  // persisted, so a reload re-reads server truth. Every question surface reads
  // it through sessionHasOpenQuestion so none can disagree (lib/decisionQueue).
  questionResolutions: QuestionResolutions;
  // `sends` = how many messages the resolving gesture itself puts into the
  // conversation (1 for an answer, 0 for a dismissal/eviction), so the mark
  // doesn't expire on its own echo.
  resolveSessionQuestion: (convId: string, opts?: { sends?: number }) => void;

  // -- Manual session buckets --
  buckets: Record<string, BucketItem>;
  bucketAssignments: Record<string, BucketAssignmentItem>;
  // Mutually exclusive with activeProjectFilter: the chip row is ONE filter.
  activeBucketFilter: string | null;
  setActiveBucketFilter: (bucketId: string | null, exclude?: boolean) => void;
  // Panel view mode with back-compat for the pre-bucket inbox_flat_view bool.
  inboxViewMode: () => InboxViewMode;
  setInboxViewMode: (mode: InboxViewMode) => void;
  cycleInboxViewMode: () => void;
  // Drag-to-reorder in the "time" view: pin `id` at `key` (epoch-ms space).
  setSessionManualOrder: (id: string, key: number) => void;
  // Forget all manual pins — the "time" view returns to pure creation order.
  clearManualOrder: () => void;

  // -- Recently visited (sessions, chip views, pages) — newest first --
  recentVisits: RecentVisit[];
  recordRecentVisit: (visit: Omit<RecentVisit, "ts">) => void;
  /** The Threads page's session read mark: "seen up to the current message
   *  count". Local only — a session's read state never dispatches. */
  markSessionSeen: (id: string) => void;
  createBucket: (opts: { name: string; color?: string }, continuation?: DurableCreateContinuation) => Promise<{ bucketId: string }>;
  /** Local-first team create: a stub team row and the active team switch land
   *  in the same tick; resolves the REAL team id once the server answers, and
   *  rolls the stub and the active team back if it refuses. */
  createTeam: (opts: { name: string; icon?: string; icon_color?: string }) => Promise<string>;
  dispatchCreateTeam: (stubId: string, opts: { name: string; icon?: string; icon_color?: string }) => Promise<string>;
  resolveTeamStub: (stubId: string, teamId: string) => void;
  discardTeamStub: (stubId: string, previousActiveTeamId: string | undefined) => void;
  updateBucket: (id: string, fields: { name?: string; color?: string; sort_order?: number; archived_at?: number | null }) => void;
  assignSessionToBucket: (conversationId: string, bucketId: string | null) => void;

  // Teammate comment actions (optimistic → dispatch side-effect → live-query reconcile).
  addComment: (conversationId: string, content: string, opts?: { messageId?: string; parentCommentId?: string; filePath?: string; lineNumber?: number }) => Promise<unknown>;
  editComment: (commentId: string, content: string) => Promise<unknown>;
  deleteComment: (commentId: string) => Promise<unknown>;
  askAgentInThread: (conversationId: string, opts?: { messageId?: string; filePath?: string; lineNumber?: number }) => Promise<unknown>;
  resolveCommentThread: (conversationId: string, anchor: { messageId?: string; filePath?: string; lineNumber?: number }, resolved: boolean) => void;

  // -- Sidebar nav expanded sections --
  sidebarNavExpanded: Record<string, boolean>;
  toggleSidebarNav: (section: string) => void;
  // Mark a live subscription's cold-open first-load (see `liveLoading`).
  setLiveLoading: (scope: string, loading: boolean) => void;

  // Teammate comments — a synced collection (live query → syncTable), so reads
  // are instant from cache and writes render optimistically like everything else.
  comments: Record<string, CommentRow>;

  // -- Task / Doc / Plan / Project state --
  tasks: Record<string, TaskItem>;
  taskActiveSessions: Record<string, any>;
  // Dormant origin-session badges keyed by conversation id, fetched one-shot by
  // useSyncTasks (tasks.webTaskOrigins). Task rows no longer carry origin_session
  // from the server — the tasks page derives it from this map at render.
  taskOriginBadges: Record<string, NonNullable<TaskItem["origin_session"]> & { agent_type?: string }>;
  // Progress of the full reconcile crawls (useSyncTasks / useSyncDocs), keyed by
  // scope ("tasks" | "docs"). Ephemeral UI state so any list view can show a
  // subtle "syncing N" badge and never imply the list is complete while pages
  // are still streaming in. `loaded` counts rows crawled so far this run;
  // `loading` is true until the final page lands.
  syncProgress: Record<string, { loading: boolean; loaded: number }>;
  // First-load state of the LIVE data subscriptions (sessions / docs / tasks),
  // keyed by scope. Deliberately separate from `syncProgress`, which tracks the
  // background reconcile crawl: that crawl pages through EVERY row at a throttled
  // pace and can run for minutes, so gating the header spinner on it kept it lit
  // ~forever. `liveLoading[scope]` is true only until the subscription delivers
  // its first payload on a cold open, then false — so the header SyncStatusChip
  // reflects "the data I'm looking at is still loading", not housekeeping.
  liveLoading: Record<string, boolean>;
  docs: Record<string, DocItem>;
  plans: Record<string, PlanItem>;
  projects: Record<string, ProjectItem>;
  savedViews: Record<string, SavedViewRow>;
  notifications: Record<string, any>;
  docProjectPaths: string[];
  docDetails: Record<string, DocDetail>;
  // Cross-team mention index — lightweight per-record snapshots loaded once
  // at the app shell so @-search works for every team the user belongs to,
  // without colliding with the active-team `tasks`/`docs`/`plans` collections
  // that page views depend on.
  mentionIndex: {
    tasks: Record<string, MentionTaskItem>;
    docs: Record<string, MentionDocItem>;
    plans: Record<string, MentionPlanItem>;
  };
  taskFilter: { status: string };
  docFilter: { type: string; query: string; project: string; scope: string };
  planFilter: { status: string };

  setTaskFilter: (filter: Partial<{ status: string }>) => void;
  setDocFilter: (filter: Partial<{ type: string; query: string; project: string; scope: string }>) => void;
  setPlanFilter: (filter: Partial<{ status: string }>) => void;

  // -- Message queue --
  sessionsWithQueuedMessages: Set<string>;
  setSessionHasQueuedMessages: (sessionId: string, hasQueued: boolean) => void;

  // Blocked-banner revive stamps: session id → when a continue/switch was
  // requested. Local + persisted, never synced (the server's pending_api_error
  // only clears when the agent actually resumes and its output syncs back).
  blockedReviveRequestedAt: Record<string, number>;

  // -- Shortcuts panel --
  shortcutsPanelOpen: boolean;
  toggleShortcutsPanel: () => void;
  // The global anchor panel: a slide-over holding one anchor's conversation,
  // reachable from every page. Ephemeral (a modal toggle, never persisted).
  // `anchorId` is the LAST anchor shown, so re-opening lands where you were.
  anchorPanel: { open: boolean; anchorId: string | null };
  openAnchorPanel: (anchorId?: string | null) => void;
  closeAnchorPanel: () => void;
  toggleAnchorPanel: () => void;

  // -- Settings modal --
  settingsModalSection: SettingsSectionId | null;
  openSettingsModal: (section?: SettingsSectionId) => void;
  closeSettingsModal: () => void;

  // -- The people wall, over the main window --
  // The same wall the people window shows, thrown over whatever you were doing
  // for as long as it takes to hold one face. Ephemeral (a modal toggle, never
  // persisted): which window you are in is not a preference.
  peopleWallOpen: boolean;
  openPeopleWall: () => void;
  closePeopleWall: () => void;
  togglePeopleWall: () => void;

  // -- Side panel --
  // -- Workspace slots (see store/workspace.ts + WORKSPACE_SLOTS.md) --
  // The layout as data: fixed slots, at most one pane each. Regions migrate
  // onto this one at a time; the legacy flags below disappear as they land.
  workspace: WorkspaceState;
  wsShow: (slot: SlotId, pane: Pane, opts?: { presentation?: Presentation }) => void;
  wsHide: (slot: SlotId, opts?: { remember?: boolean }) => void;
  wsToggle: (slot: SlotId, pane: Pane) => void;
  wsPromote: (slot: SlotId) => void;
  wsSetPresentation: (slot: SlotId, presentation: Presentation) => void;
  /** Restore a saved arrangement wholesale — every slot, plus zen and the chip
   *  filter. `id` stamps which saved workbench this is, so the rail can keep it
   *  highlighted (and offer "update") while you adjust panels away from it.
   *  `pathname` is the surface the switch LANDS on, so a filter that evicts the
   *  focused session moves whichever pointer that surface highlights. */
  applyWorkbench: (snap: WorkbenchSnapshot, id?: string, pathname?: string | null) => void;
  /** The saved workbench the chrome was last switched to. Ephemeral bookkeeping
   *  for the rail's highlight/update affordance — cleared on plain boots. */
  activeWorkbenchId: string | null;
  /** Name the current arrangement and persist it as a saved view. */
  saveWorkbench: (name: string, path?: string) => any;
  /** Overwrite a saved workbench with the CURRENT arrangement — the way an
   *  existing workbench is adjusted: switch to it, move panels, update. */
  updateWorkbench: (id: string, path?: string) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setDockOpen: (open: boolean) => void;
  wsSetSize: (slot: SlotId, size: number) => void;


  sidePanelSessionId: string | null;
  openSidePanel: (sessionId: string) => void;
  closeSidePanel: () => void;
  clearSidePanelSession: () => void;
  toggleSidePanel: () => void;
  selectPanelSession: (sessionId: string | null) => void;


  // -- Task / Doc mutations (action + side effect) --
  updateTaskStatus: (shortId: string, status: string, subtaskResolution?: "cascade" | "only_parent") => Promise<any>;
  updateTask: (shortId: string, fields: { status?: string; status_id?: string; priority?: string; title?: string; description?: string; labels?: string[]; triage_status?: string; assignee?: string; execution_status?: string; project_id?: string; project_path?: string; parent?: string; sort_order?: number; duplicate_of?: string; subtask_resolution?: "cascade" | "only_parent" }) => Promise<any>;
  createTask: (opts: { title: string; description?: string; task_type?: string; priority?: string; status?: string; project_id?: string; labels?: string[]; assignee?: string; plan_id?: string; team_id?: string; workspace?: string; project_path?: string; parent?: string; client_key?: string }) => Promise<any>;
  clearSavedViewTombstones: () => void;
  removeTaskStub: (clientKey: string) => void;
  createDoc: (opts: { title: string; content?: string; doc_type?: string; parent_id?: string; labels?: string[]; workspace?: "personal" | "team"; team_id?: string }, continuation?: DurableCreateContinuation) => Promise<any>;
  createPlan: (opts: { title: string; body?: string; goal?: string; acceptance_criteria?: string[]; status?: string; source?: string; project_id?: string; model_stylesheet?: string; fidelity?: string; join_policy?: string; join_k?: number; workspace?: "personal" | "team"; team_id?: string }, continuation?: DurableCreateContinuation) => Promise<any>;
  createProject: (opts: { title: string; description?: string; status?: string; color?: string; icon?: string; workspace?: "personal" | "team"; team_id?: string }, continuation?: DurableCreateContinuation) => Promise<any>;
  promoteDocToPlan: (docId: string) => Promise<any>;
  ensurePlanDoc: (planShortId: string) => Promise<any>;
  publishToDirectory: (opts: { conversation_id: string; title: string; description?: string; tags?: string[] }) => Promise<any>;
  moveDoc: (id: string, parentId?: string, sortOrder?: number) => Promise<any>;
  updatePlan: (shortId: string, fields: { title?: string; goal?: string; acceptance_criteria?: string[]; status?: string; task_ids?: string[]; context_pointers?: Array<{ label: string; path_or_url: string }> }) => void;
  updateProject: (id: string, fields: { title?: string; description?: string; status?: string; color?: string; icon?: string }) => void;

  addTaskComment: (shortId: string, text: string, commentType?: string, imageIds?: string[]) => Promise<any>;
  updateDoc: (id: string, fields: { content?: string; title?: string; doc_type?: string; labels?: string[] }) => void;
  pinDoc: (id: string, pinned: boolean) => Promise<any>;
  archiveDoc: (id: string) => Promise<any>;
  restoreArchivedDoc: (id: string) => void;

  // -- Cached query data (local-first) --
  currentUser: any | null;
  teams: any[];
  teamMembers: any[];
  // Huddles (calls.ts). myCalls syncs the ring pipeline's whole world in one
  // singleton: invites ringing at me, my outbound ring, my room membership.
  // callOccupancy maps room_key → live roster for chips. Neither persists —
  // a reload re-derives both from the subscription (a stale ring replayed
  // from IDB would be a phantom ring).
  myCalls: { incoming: any[]; outgoing: any[]; membership: any | null };
  callOccupancy: Record<string, any[]>;
  callConfig: { enabled: boolean; url?: string } | null;
  // Every huddle running right now in one of my teams (calls.getLiveRooms) —
  // what makes an occupied room visible from anywhere: the sidebar's Live now
  // cluster, /calls' Happening now, the lock state of the room I'm in. Live
  // occupancy is ephemeral by nature, so like myCalls it never persists: a
  // reload re-derives it, and a room replayed from IDB would be a ghost.
  liveRooms: LiveRoom[];
  // People waiting at MY door (calls.getRoomKnocks) — only ever the room I am
  // seated in, since a knock is a gesture at one door.
  roomKnocks: RoomKnock[];
  // Rooms I have knocked at, key → when. Two jobs: the "knocked" confirmation
  // on the row I clicked, and the auto-accept in useCallRing — the admit ring
  // for a door I knocked on must not ask me to answer it.
  callKnocked: Record<string, number>;
  // In-flight lock toggles, room_key → desired state. Local-first: the lock
  // glyph flips on click and this protects it through getLiveRooms pushes
  // computed before setRoomLocked committed (same shape as myStatusPending).
  callLockPending: Record<string, { locked: boolean; at: number }>;
  noteKnock: (roomKey: string) => void;
  clearKnock: (roomKey: string) => void;
  noteLockPending: (roomKey: string, locked: boolean) => void;
  revertLockPending: (roomKey: string, locked: boolean) => void;
  // Ephemeral media-plane state, written only by lib/calls/callManager. The
  // dock renders from THIS synchronously (local-first: joining paints
  // "connecting" before any server or SFU round-trip).
  call: {
    phase: "idle" | "ringing_out" | "connecting" | "connected" | "error";
    roomKey: string | null;
    muted: boolean;
    /** The microphone could not be opened for this seat — denied, blocked, or
     *  no device. A seat like that still HEARS the room; it publishes nothing.
     *  Implies `muted`, and it is the difference between a person who chose
     *  silence and one who has no choice, which is the whole of what the strip
     *  and the dock have to say honestly. */
    micDenied: boolean;
    camera: boolean;
    sharing: boolean;
    speaking: string[];
    error: string | null;
  };
  setCallState: (patch: Partial<InboxStoreState["call"]>) => void;
  teamUnreadCount: number | null;
  favorites: any[];
  bookmarks: any[];
  // In-flight optimistic bookmark toggles, keyed by message_id → desired state.
  // Memory-only (unregistered, so never persisted). The bookmarks list sync
  // re-applies these on top of each server push and clears an entry once the
  // server agrees, so an unrelated heartbeat re-push of listBookmarks can't
  // revert a toggle before its own mutation has committed.
  bookmarkPending: Record<string, { bookmarked: boolean; conversationId: string }>;

  // The viewer's in-flight manual status flip (setMyStatus). teamMembers is a
  // wholesale-replaced list, so the teamMembers normalize re-applies this on
  // top of each push until the server reflects it (or the TTL expires).
  myStatusPending: { userId: string; status: string; at: number } | null;

  // -- Selectors --
  getSession: (id: string) => InboxSession | undefined;
}

const DEFAULT_PAGINATION: PaginationState = {
  lastTimestamp: null,
  oldestTimestamp: null,
  hasMoreAbove: false,
  hasMoreBelow: false,
  isLoadingOlder: false,
  isLoadingNewer: false,
  jumpMode: null,
  loadedStartIndex: 0,
  isSearchingForTarget: false,
  initialized: false,
};

function stripImageRef(s: string): string {
  return s.replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
}

function messageReplayKey(message: Message): string | null {
  if (message._isOptimistic || message._isQueued || message._isFailed) return null;
  if (message.message_uuid) return `uuid:${message.message_uuid}`;
  return `exact:${JSON.stringify([
    message.role,
    message.timestamp,
    message.content || "",
    message.thinking || "",
    message.tool_calls || null,
    message.tool_results || null,
    message.images || null,
    message.subtype || "",
  ])}`;
}

// Prune pending sends confirmed by an incoming server batch: a server user row
// matching by client_id, or by content within the 120s echo window, retires the
// optimistic bubble. Shared by setMessages (page/snapshot applies) and
// applyTailMessages (live tail applies). Only reassigns when something was
// actually pruned — the filter is a remove-only pass, so equal length means
// identical contents, and keeping the old reference avoids churning
// pendingMessages identity on every streaming tick (defeats SessionCard memo).
function prunePendingEchoes(draft: any, convId: string, incoming: Message[]) {
  const pending = draft.pendingMessages[convId] || [];
  if (pending.length === 0) return;
  const serverUserMsgs = incoming.filter((m: Message) => m.role === "user");
  const kept = pending.filter((m: Message) => {
    if (m._clientId) {
      return !serverUserMsgs.some((s: Message) => s.client_id === m._clientId);
    }
    const stripped = stripImageRef(m.content || "");
    return !serverUserMsgs.some((s: Message) =>
      stripImageRef(s.content || "") === stripped &&
      Math.abs(s.timestamp - m.timestamp) < 120_000
    );
  });
  if (kept.length !== pending.length) {
    draft.pendingMessages[convId] = kept;
  }
}

function dedupeReplayedMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const key = messageReplayKey(message);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(message);
  }
  return out;
}

// Max conversations to keep messages for in the in-memory store. Generous on
// purpose — instant switching across a lot of recent conversations is the point —
// but bounded, because the store never prunes and message bodies carry inline
// images. Evicted conversations stay in IDB and reload instantly.
export const MAX_IN_MEMORY_CONVERSATIONS = 400;

export function evictInactiveMessages(draft: any, activeConvId: string) {
  const loaded = Object.keys(draft.messages);
  if (loaded.length <= MAX_IN_MEMORY_CONVERSATIONS) return;

  const currentConvId = draft.currentConversation?.conversationId;
  // Never evict whatever is actually on screen...
  const keep = new Set([activeConvId, currentConvId, draft.currentSessionId, draft.sidePanelSessionId, draft.viewingDismissedId].filter(Boolean));

  // ...nor the small set of currently-live inbox sessions, so switching to an
  // actively-working agent is instant.
  //
  // We deliberately do NOT protect every id in draft.sessions. That map never
  // prunes (a session you've opened stays forever), so keeping messages for all
  // of them defeated this LRU entirely: every conversation ever opened was pinned
  // in memory, letting the store balloon to multiple GB over a few days of use.
  // The cap above is the real bound; anything past it reloads from IDB on click.
  const live = draft.liveInboxIds;
  if (live) for (const id of live) keep.add(id);

  // Evict least-recently-viewed first
  // Never evict conversations with pending messages — the user just sent something
  // and evicting would make it vanish from the UI
  const viewedAt = draft._lastViewedAt || {};
  const candidates = loaded
    .filter((id: string) => !keep.has(id) && !(draft.pendingMessages[id]?.length > 0))
    .sort((a: string, b: string) => (viewedAt[a] ?? 0) - (viewedAt[b] ?? 0));

  const toEvict = candidates.slice(0, loaded.length - MAX_IN_MEMORY_CONVERSATIONS);
  for (const id of toEvict) {
    delete draft.messages[id];
    // NEVER evict pendingMessages — these are the user's outbound messages
    // and must survive until confirmed by the server
    delete draft.pagination[id];
    delete draft.userMessages[id];
  }
}

// Record that the user switched INTO session `id`. The single source of truth
// for "last viewed", called from EVERY navigation primitive so a visit is
// recorded no matter how a session was opened (inbox click, deep-link, ?s=,
// popstate, Tab palette, dedicated session window, desktop window-focus). Must
// run while `prevId` still holds the session being left (i.e. before the caller
// reassigns currentSessionId/sidePanelSessionId).
//
//   - _lastViewedAt[id] -> now: entered-at, drives MRU order. Only ever bumped
//     here, so the session you just opened is always strictly the most recent.
//   - _seenUpToAt[prevId] -> now: leaving the previous session means you've now
//     seen everything in it; advancing here (and NOT for `id`) is what keeps the
//     "New" divider for `id` frozen at where you left off last time.
function recordSessionView(draft: any, id: string, prevId?: string | null) {
  if (!id) return;
  const now = Date.now();
  if (prevId && prevId !== id) {
    draft._seenUpToAt[prevId] = now;
    // Snapshot what you'd seen by the time you left, so a branch chip's unread
    // badge counts only what arrived afterward. Prefer the freshest count we
    // hold for prevId; if we have none, leave any prior cursor untouched.
    const seenCount = draft.conversations[prevId]?.message_count
      ?? draft.sessions[prevId]?.message_count;
    if (typeof seenCount === "number") draft._seenMessageCount[prevId] = seenCount;
  }
  draft._lastViewedAt[id] = now;
  // Unified recents (header dropdown + palette). Title snapshot is only a
  // fallback for sessions that later leave the store — display resolves live.
  const title = draft.sessions[id]?.title ?? draft.conversations[id]?.title;
  recordVisitInDraft(draft, { kind: "session", key: id, label: title || undefined });
}

// One ordered list behind every "recently visited" surface: the header
// dropdown, the command palette's top group. Entries hold ids + a label
// snapshot; display text resolves live at render (lib/recentVisits).
//   kind "session" — key is the conversation id
//   kind "view"    — key "label:<bucketId>" or "project:<name>" (chip filters)
//   kind "page"    — key "page:<path>" (in-shell tab navigation)
export type RecentVisit = {
  kind: "session" | "view" | "page";
  key: string;
  ts: number;
  label?: string;
  path?: string;
};

const RECENT_VISITS_CAP = 30;

function recordVisitInDraft(draft: any, visit: Omit<RecentVisit, "ts">) {
  // History traversal re-applies view filters through the same setters that
  // record visits — replaying the past must not rewrite the recents order.
  if (isApplyingViewHistory()) return;
  const list: RecentVisit[] = draft.recentVisits ?? [];
  const next = list.filter((v) => v.key !== visit.key);
  next.unshift({ ...visit, ts: Date.now() });
  if (next.length > RECENT_VISITS_CAP) next.length = RECENT_VISITS_CAP;
  draft.recentVisits = next;
}

// The store's current view settings as a history snapshot (lib/inboxViewHistory).
function snapshotInboxViewFromDraft(draft: any): InboxViewSnapshot {
  const ui = draft.clientState?.ui ?? {};
  return {
    bucket: draft.activeBucketFilter ?? null,
    project: draft.activeProjectFilter ?? null,
    projectPath: draft.activeProjectPath ?? null,
    exclude: !!draft.chipFilterExclude,
    mode: ui.inbox_view_mode ?? (ui.inbox_flat_view ? "time" : "grouped"),
  };
}

// Index of the timeline row the Slack-style "New" divider sits above, or -1 for
// none. The unread band is the half-open interval (seenUpToAt, enteredAt]:
//   - lower bound `seenUpToAt`  — when you last LEFT this session (frozen for
//     the visit), so the line holds its place while you read.
//   - upper bound `enteredAt`   — when you last FOCUSED this session (re-stamped
//     on every entry, incl. window-focus). Anything newer than this arrived
//     while you were here watching — your own sends, live agent replies — and
//     must NOT get a "New" line. Without this bound the first live message after
//     a caught-up entry wrongly anchored the divider.
// timeline is ascending by timestamp, so the first row past `seenUpToAt` is the
// earliest unseen; we only honor it when it predates `enteredAt`.
export function computeNewDividerIndex(
  timeline: readonly { timestamp: number }[],
  seenUpToAt: number,
  enteredAt: number,
): number {
  if (!seenUpToAt) return -1;
  const idx = timeline.findIndex((it) => it.timestamp > seenUpToAt);
  if (idx === -1) return -1;
  if (enteredAt && timeline[idx].timestamp > enteredAt) return -1;
  return idx;
}

// -- Sync infrastructure --

export type MergePolicy = "replace" | "local_wins" | "set_union" | "deep_merge";
type MergeFn = (local: any, server: any, initialized: boolean) => any;
export interface MergeSpecMap { [key: string]: MergePolicy | MergeSpecMap | MergeFn }
export type MergeSpec = MergePolicy | MergeSpecMap | MergeFn;

export type SyncOpts = {
  kind?: "collection" | "singleton" | "list" | "scalar";
  merge?: Record<string, MergeSpec>;
  altKey?: string;
  keepSelected?: string;
  transform?: (draft: any, result: any, incoming: any, initialized: boolean, prev?: any) => void;
  extra?: Record<string, any>;
  // When true, `incoming` is treated as a partial set of changed records:
  // missing rows in `prev` are preserved instead of being dropped. Used for
  // delta-cursor queries (e.g. tasks.webList with `since`). Soft-deletes
  // arrive as updated rows; hard deletes are NOT supported in delta mode.
  isDelta?: boolean;
  // Perf escape hatch for applySyncTable's identity reuse: by default it compares
  // ALL scalar fields, so any per-push-churning scalar would re-render the row
  // every push. List such a field here to exclude it from the version key. Safe
  // to omit — a mistake here only costs an extra render, never a dropped update.
  ignoreFields?: string[];
  // Fields owned by a separate overlay channel (syncOverlay), not the base
  // payload. On a base sync these keep their previous (overlay-set) value rather
  // than being clobbered by the base's null — so the base list and the liveness
  // overlay can write the same rows without fighting. See sessions + syncOverlay.
  preserveFields?: string[];
  // Delta mode normally treats absence as "unchanged", so hard deletes never
  // propagate. When the payload is the COMPLETE server set for some scope (a
  // full reconcile crawl of one workspace), pass a predicate for that scope:
  // in-scope records absent from the payload are removed via an exclude-pending
  // entry (the deletion contract the IDB diff honors). Per-call only — not for
  // SYNC_REGISTRY, since scope depends on what was crawled.
  pruneAbsentScope?: (record: any) => boolean;
  // Applied to `incoming` before the list/singleton equality bail. Use it to
  // quantize volatile fields (presence timestamps, streaming counters) whose
  // per-push value changes defeat the JSON compare even though nothing the UI
  // shows has changed — teamMembers re-pushed ~every 2s on teammates' heartbeat
  // and message-count ticks, waking every subscriber of the roster ref.
  // The second argument is the store draft, for entries that reconcile local
  // pending state against the payload (teamMembers' status overlay) — running
  // BEFORE the equality bail, unlike transform, so a protected no-op push
  // still bails instead of waking every subscriber.
  normalize?: (incoming: any, draft?: any) => any;
};

// Per-key last-writer-wins for a flat preference bag whose writes carry a
// sibling "<key>:ts" timestamp (see updateClientDismissed). The newer side
// wins each key, so a preference toggled on one device genuinely reaches the
// others — blanket local_wins made the bag fork per device forever (the
// "Open links in desktop app" toggle showing ON while the server, and every
// other client, said OFF). Unstamped keys (legacy bags) keep exact local_wins
// per-key semantics: a local value beats the server echo (no flicker on a
// just-made write), a key only the server has flows in.
export function mergeStampedBagLww(local: any, server: any, initialized: boolean): any {
  if (!initialized || local == null) return server;
  if (server == null) return local;
  const out: Record<string, any> = {};
  const keys = new Set([...Object.keys(server), ...Object.keys(local)]);
  for (const k of keys) {
    if (k.endsWith(":ts")) continue;
    const lts = typeof local[`${k}:ts`] === "number" ? local[`${k}:ts`] : 0;
    const sts = typeof server[`${k}:ts`] === "number" ? server[`${k}:ts`] : 0;
    const src = sts > lts ? server : lts > sts ? local : k in local ? local : server;
    if (src[k] !== undefined) out[k] = src[k];
    const ts = src === server ? sts : lts;
    if (ts) out[`${k}:ts`] = ts;
  }
  return out;
}

// The ui keys whose writes carry a ":ts" stamp (updateClientUI), making them
// per-key LWW across devices: the inbox VIEW configuration — scope, view mode,
// the subagents / old-sessions toggles — is a per-USER preference ("the view
// follows me"), not a per-device one. Everything else in the ui bag stays
// unstamped and keeps exact legacy local_wins semantics: layout-ish prefs
// (sidebar, zen mode, theme, active team) are naturally per-device, and
// silently globalizing them would yank screens out from under people.
export const STAMPED_UI_KEYS = new Set([
  "inbox_scope", "inbox_view_mode", "inbox_flat_view", "show_subagents", "show_triggers", "card_bars", "inbox_show_old",
  "simple_view", "inbox_image_thumbs", "composer_suggestions", "inbox_home", "threads_include_sessions",
  "walkie_hold_seen", "call_camera_on",
]);

function applyMerge(local: any, server: any, spec: MergeSpec, initialized: boolean): any {
  if (typeof spec === "function") return spec(local, server, initialized);
  if (typeof spec === "string") {
    switch (spec) {
      case "replace": return server;
      case "local_wins":
        if (!initialized || local == null) return server;
        if (typeof local === "object" && typeof server === "object"
            && !Array.isArray(local) && !Array.isArray(server)) {
          return { ...server, ...local };
        }
        return local;
      case "set_union":
        return [...new Set([...(server ?? []), ...(local ?? [])])];
      case "deep_merge":
        if (local != null && server != null && typeof local === "object" && typeof server === "object"
            && !Array.isArray(local) && !Array.isArray(server)) {
          return { ...local, ...server };
        }
        return server ?? local;
      default: return server;
    }
  }
  const result = { ...server };
  let allSame = local != null && typeof local === "object";
  for (const [key, fieldSpec] of Object.entries(spec as Record<string, MergeSpec>)) {
    result[key] = keepLocalIfEqual(local?.[key], applyMerge(local?.[key], server?.[key], fieldSpec, initialized));
    if (allSame && result[key] !== local[key]) allSame = false;
  }
  if (allSame) {
    // Every merged sub-bag kept its local identity; the remaining (unspec'd)
    // keys decide whether the whole doc is a no-op push.
    for (const key of new Set([...Object.keys(result), ...Object.keys(local)])) {
      if (key in (spec as object)) continue;
      if (!valueEqual(result[key], local[key])) { allSame = false; break; }
    }
    if (allSame) return local;
  }
  return result;
}

// Merge outputs are freshly built objects even when nothing inside them changed
// (a clientState push touched current_conversation_id, not ui). Handing back
// the previous reference for a value-equal sub-bag keeps every `s.clientState.ui`
// subscriber asleep — the inbox panel re-rendered in full on each such push.
function valueEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
function keepLocalIfEqual<T>(local: T, merged: T): T {
  return local != null && merged !== local && valueEqual(local, merged) ? local : merged;
}

// Presence-ish timestamps tick every few seconds server-side (daemon heartbeat,
// teammate activity), but every consumer renders or thresholds them at minute
// granularity or coarser (isOnline's 5-min window, offlineTierFor's 10-min warn,
// the profile page's 60s "connected" check). Quantizing them to the minute
// BEFORE the sync-layer equality bail turns the constant heartbeat re-pushes
// into value-identical no-ops, so the roster/user refs stay stable and their
// subscribers stop re-rendering at idle.
const PRESENCE_QUANTUM_MS = 60_000;
const PRESENCE_FIELDS = ["daemon_last_seen", "last_heartbeat", "last_seen", "recent_session_updated", "presence_input_at"];
// Streaming counters shown only in hover tooltips (a teammate's message count
// ticks up on every agent turn); step them so the roster ref doesn't churn on
// each increment.
const COUNTER_QUANTUM = 16;
const COUNTER_FIELDS = ["recent_session_messages"];
function quantizePresence<T>(rec: T): T {
  if (!rec || typeof rec !== "object") return rec;
  let out: any = rec;
  const setQ = (k: string, q: number, v: number) => {
    if (q !== v) {
      if (out === rec) out = { ...(rec as any) };
      out[k] = q;
    }
  };
  for (const k of PRESENCE_FIELDS) {
    const v = (rec as any)[k];
    if (typeof v === "number") setQ(k, Math.floor(v / PRESENCE_QUANTUM_MS) * PRESENCE_QUANTUM_MS, v);
  }
  for (const k of COUNTER_FIELDS) {
    const v = (rec as any)[k];
    if (typeof v === "number") setQ(k, Math.floor(v / COUNTER_QUANTUM) * COUNTER_QUANTUM, v);
  }
  return out;
}

const SYNC_REGISTRY: Record<string, SyncOpts> = {
  // Data-only sync opts registered on the collection itself (clientSyncRegistry
  // `sync`) land first; the entries below add or override the store-internal
  // ones (transforms, merges, normalizers).
  ...REGISTRY_SYNC_OPTS,
  sessions: {
    altKey: "session_id",
    keepSelected: "currentSessionId",
    // Liberal cache: the live listInboxSessions window syncs as a DELTA overlay
    // (like tasks/docs), so a session the server stops returning is NOT pruned
    // locally — the inbox accumulates across syncs and across cold-open reloads.
    // Sessions leave only on an explicit gesture: a dismissal (an in-window
    // update that overlays here, including one made on another device) re-buckets
    // them, and a kill removes them via an exclude-pending entry. Without this the
    // snapshot prune mirrored the server's narrow recent-window and evicted older
    // (especially dismissed) sessions on every sync and every reload.
    isDelta: true,
    // Heartbeat-derived liveness rides a separate overlay (useSessionLiveness →
    // syncOverlay) so the base listInboxSessions stops re-pushing the whole list
    // every ~1s. The base now carries null for these, so preserve the overlay's
    // value here instead of clobbering it between overlay ticks.
    preserveFields: [
      "agent_status", "is_idle", "is_unresponsive", "awaiting_input",
      "is_connected", "tmux_session", "permission_mode", "agent_started_at",
      "open_tasks", "open_tasks_at",
      // Fast fields: change on every streamed message, so they ride the overlay
      // too (fast_fields_in_overlay) — otherwise every token re-pushed the list.
      "message_count", "updated_at",
      "_postCreateBucketId",
    ],
    transform(draft, table, incoming) {
      for (const s of incoming as any[]) {
        if (!draft.conversations[s._id]) draft.conversations[s._id] = { _id: s._id };
        // Drop stale optimistic sends now that we have authoritative status —
        // keeps phantom "pending" pills from pinning idle sessions in Working.
        reconcilePendingSendForSession(
          draft.pendingMessages,
          s._id,
          (table[s._id] as InboxSession | undefined) ?? s,
          draft.currentSessionId,
          draft.messages[s._id],
        );
      }
      if (!draft.currentSessionId && !draft.showMySessions &&
          Object.keys(table).length > 0 && draft.clientStateInitialized &&
          !hasViewNavigated()) {
        // The fleet board is the home surface: when it's the resolved inbox
        // home, boot lands on the board (showMySessions) instead of adopting a
        // conversation — "what is happening" before "where was I". A deep link
        // or any real navigation still wins (hasViewNavigated above).
        if (resolveInboxHome(draft.clientState.ui) === "board") {
          draft.showMySessions = true;
          return;
        }
        // Prefer this client's OWN last position. The per-user synced pointer
        // is consulted only by a client that has never had one (fresh
        // profile): any other client — another device, an agent-driven tab —
        // can move the synced value, so adopting it on a client with history
        // is the "jumps to a random session" bug. A client whose own position
        // is gone from the table falls to the top of the inbox, never to the
        // synced pointer.
        const persisted = draft.lastFocusedConversationId
          ?? draft.clientState.current_conversation_id;
        const sorted = sortSessions(table as Record<string, InboxSession>);
        declareViewNav("adopt");
        draft.currentSessionId = (persisted && table[persisted])
          ? persisted : (sorted[0]?._id ?? null);
      }
    },
  },
  // Liberal cache for the big id-keyed collections, same rule as sessions: every
  // write is a DELTA overlay. The live window AND the reconcile crawl both only
  // ADD/UPDATE — neither prunes. A row the server stops returning is never wiped
  // locally; deletions arrive as deltas (status="dropped" etc.) and are hidden by
  // read-time filters. This is the systemic guarantee that nothing can snapshot-
  // gut the cache — the root of the "tasks vanish then stream back" collapses.
  // altKey "client_key" supersedes an optimistic create-stub: the quick-add
  // writes a stub keyed by a non-Convex id carrying a minted client_key, and
  // when the server row syncs back with the same client_key the delta rekeys
  // the stub onto the real _id and drops the stub (moving its pending tombstone
  // too). webCreate is idempotent on client_key, so a retry never doubles the
  // server row either. Replaces the manual stub-adopt path.
  tasks: {
    isDelta: true,
    altKey: "client_key",
    // The detail joins (activity, linked sessions, related docs, source
    // insight) ride only webGetTaskDetail, live while a task is open; the list
    // channels (webList, webListPaginated, webGetByIds) never carry them.
    // Preserve them across list deltas so a fetched task's detail renders
    // instantly from cache on the next open instead of reloading async. Fields
    // the list DOES carry (creator, assignee_info, plan) stay list-authoritative.
    preserveFields: ["comments", "history", "linked_conversations", "related_docs", "source_insight"],
  },
  // The decision queue. NOT delta: listForUser returns the complete visible
  // window (pending + 24h of resolved) on every push, so absence means the
  // row aged out — delta mode would pin cleared decisions in the queue
  // forever. localFirst pending-protection covers the answer flip until the
  // server echo confirms it.
  sessionDecisions: {},
  // NOT delta: savedViews.webList returns the complete visible set on every
  // push, so absence means removed. Delta mode would treat a deleted or
  // un-shared view as "unchanged" and leave it on the rail forever.
  savedViews: { altKey: "client_key" },
  // altKey supersede for optimistic create-stubs: the incoming server row with
  // the same name rekeys the stub away (names are per-user and practically
  // unique; a rare duplicate-name create just retires the stub onto the older
  // row while the new server row arrives alongside).
  buckets: { isDelta: true, altKey: "name" },
  // Optimistic first-assignments add a local stub row keyed `bucketassign-<convId>`;
  // altKey rekeys that stub onto the server's real (user, conversation) row when
  // it syncs — the same supersede machinery session create-stubs ride.
  bucketAssignments: { isDelta: true, altKey: "conversation_id" },
  // Teammate comments per conversation. isDelta so syncing one conversation's
  // thread never prunes another's; altKey "client_id" rekeys an optimistic stub
  // onto its real server row (the stub carries client_id === its own stub id).
  comments: { isDelta: true, altKey: "client_id" },
  // Team chat. Same delta rule as everything above — syncing one channel's page
  // never prunes another's, and a thread's replies survive a channel sync. See
  // store/chatSlice.ts for why these collections carry no pending protection.
  ...CHAT_SYNC_REGISTRY,
  // capabilityState / capabilityBindings: registered on the collection.
  // Crosstalk graph: the server stamps generatedAt on every execution, which
  // would defeat the singleton's equality bail and wake subscribers on every
  // no-op push. Strip it before the compare.
  sessionThreads: {
    kind: "singleton",
    normalize: (v: any) => (v && typeof v === "object" ? { links: v.links ?? [], nodes: v.nodes ?? [] } : v),
  },
  clientState: {
    kind: "singleton",
    merge: {
      // Per-key LWW for the stamped inbox-view prefs (STAMPED_UI_KEYS); every
      // unstamped key keeps exact local_wins per-key semantics. Blanket
      // local_wins forked the bag per device forever — a pref changed on any
      // other device never reached a client that already held the key.
      ui: mergeStampedBagLww,
      layouts: "local_wins",
      dismissed: mergeStampedBagLww,
      drafts: "local_wins",
      tabs: "deep_merge",
      activeTabId: "deep_merge",
      tips: {
        seen: "set_union",
        dismissed: "set_union",
        completed: "set_union",
        level: "local_wins",
        _inlineSuppressed: "local_wins",
      },
    },
    transform(draft, result, incoming, initialized) {
      if (!incoming.ui) {
        const compat = { sidebar_collapsed: incoming.sidebar_collapsed, zen_mode: incoming.zen_mode };
        result.ui = result.ui ? { ...compat, ...result.ui } : compat;
      }
      if (!incoming.layouts && incoming.layout) {
        result.layouts = { ...(result.layouts || {}), dashboard: incoming.layout };
      }
      // Hydrate tabs from server on first sync
      if (incoming.tabs && Array.isArray(incoming.tabs) && draft.tabs.length === 0) {
        draft.tabs = healTabPaths(incoming.tabs);
      }
      if (incoming.activeTabId && !draft.activeTabId) {
        draft.activeTabId = incoming.activeTabId;
      }
      if (!initialized) {
        if (incoming.drafts) {
          for (const [k, v] of Object.entries(incoming.drafts)) {
            if (v && typeof v === "object" && !draft.drafts[k]) {
              draft.drafts[k] = v as Record<string, any>;
            }
          }
        }
        // Deliberately NO position restore here. This branch runs only when a
        // server sync beats IDB hydration, and the synced per-user pointer is
        // writable by every client (other devices, agent-driven tabs) — a
        // boot pull from it teleported the desktop into random sessions
        // (ct-36620, ct-36951). Restore lives in the hydration block (own
        // local position first) and the sessions-sync fallback (synced
        // pointer only for clients with no history); both select, neither
        // navigates.
      }
    },
  },
  currentUser: { kind: "singleton", normalize: quantizePresence },
  // Server-authoritative call state: wholesale replace (no local edits to
  // protect — the optimistic layer for calls is the ephemeral `call` slice,
  // not these rows). Timestamps are bucketed server-side (calls.ts), so
  // no-change pushes bail on the JSON compare.
  myCalls: { kind: "singleton" },
  callOccupancy: { kind: "singleton" },
  callConfig: { kind: "singleton" },
  // Live huddles, wholesale-replaced on every push (the server sorts rooms
  // and rosters and buckets timestamps, so a heartbeat that changed nothing
  // bails on the JSON compare). The one local edit to protect is an in-flight
  // lock toggle: a push computed before setRoomLocked committed would flap the
  // glyph back for a beat. Protection lives in normalize, like teamMembers, so
  // the no-change bail still swallows heartbeat pushes.
  liveRooms: {
    kind: "list",
    normalize: (list: any, draft?: any) => {
      if (!Array.isArray(list)) return list;
      const pending = draft?.callLockPending as Record<string, { locked: boolean; at: number }> | undefined;
      if (!pending || Object.keys(pending).length === 0) return list;
      return list.map((room: any) => {
        const p = room && pending[room.room_key];
        if (!p) return room;
        // The TTL keeps a failed mutation from pinning a lock the server never
        // accepted; agreement clears the entry and stops the protection.
        if (Date.now() - p.at > 30_000 || room.locked === p.locked) {
          delete pending[room.room_key];
          return room;
        }
        return { ...room, locked: p.locked };
      });
    },
  },
  roomKnocks: { kind: "list" },
  teams: { kind: "list" },
  teamMembers: {
    kind: "list",
    // Beyond presence quantization, overlay the viewer's in-flight manual
    // status (setMyStatus): the roster is wholesale-replaced on every push,
    // and a push computed before the updateProfile mutation committed would
    // flap the optimistic pill back for a beat. Protection lives in normalize,
    // not transform, so the equality bail still swallows no-op heartbeat
    // pushes. Cleared once the server reflects the status; the TTL keeps a
    // failed dispatch from pinning a status the server never accepted.
    normalize: (list: any, draft?: any) => {
      if (!Array.isArray(list)) return list;
      const mapped = list.map(quantizePresence);
      const pending = draft?.myStatusPending;
      if (!pending) return mapped;
      if (Date.now() - pending.at > 30_000) {
        draft.myStatusPending = null;
        return mapped;
      }
      const idx = mapped.findIndex((m: any) => m && String(m._id) === pending.userId);
      if (idx === -1) return mapped;
      if ((mapped[idx].status ?? "available") === pending.status) {
        draft.myStatusPending = null; // server caught up — stop protecting
      } else {
        mapped[idx] = { ...mapped[idx], status: pending.status };
      }
      return mapped;
    },
  },
  teamUnreadCount: { kind: "scalar" },
  favorites: { kind: "list" },
  bookmarks: {
    kind: "list",
    // Local-first reconciliation: a list-kind sync wholesale-replaces the store,
    // which would clobber an optimistic toggle whose own mutation hasn't
    // committed yet (listBookmarks re-runs on any heartbeat that bumps a
    // bookmarked conversation's updated_at). Re-apply each in-flight toggle on
    // top of the server push; clear it once the server reflects the same state.
    transform: (state: any, list: any) => {
      const pending = state.bookmarkPending as Record<string, { bookmarked: boolean; conversationId: string }>;
      const ids = pending ? Object.keys(pending) : [];
      if (ids.length === 0) return;
      const present = new Set((list as any[]).map((b) => b.message_id));
      let next = state.bookmarks as any[];
      for (const messageId of ids) {
        const { bookmarked, conversationId } = pending[messageId];
        if (present.has(messageId) === bookmarked) {
          delete pending[messageId]; // server caught up — stop protecting
          continue;
        }
        next = bookmarked
          ? [{ _id: `temp_${messageId}`, conversation_id: conversationId, message_id: messageId, created_at: Date.now() }, ...next]
          : next.filter((b) => b.message_id !== messageId);
      }
      state.bookmarks = next;
    },
  },
};

// Rename pending protection entries from oldId → newId so field
// overrides survive the stub-to-Convex ID transition.
function rekeyPending(pending: Record<string, any>, oldId: string, newId: string): void {
  for (const key of Object.keys(pending)) {
    const newKey = key.replace(`:${oldId}`, `:${newId}`);
    if (newKey !== key) {
      pending[newKey] = pending[key];
      delete pending[key];
    }
  }
}

type SessionLaunchSnapshot = {
  agent_type?: string;
  project_path?: string;
  git_root?: string;
  model?: string | null;
  effort?: string | null;
  stable_mode?: string;
  stable_exclude?: string[];
};

function launchSnapshotFromRow(row: any): SessionLaunchSnapshot {
  return {
    agent_type: row?.agent_type,
    project_path: row?.project_path,
    git_root: row?.git_root,
    model: row?.model,
    effort: row?.effort,
    stable_mode: row?.stable_mode,
    stable_exclude: Array.isArray(row?.stable_exclude) ? [...row.stable_exclude] : undefined,
  };
}

function launchSnapshotsEqual(a: SessionLaunchSnapshot, b: SessionLaunchSnapshot): boolean {
  return a.agent_type === b.agent_type
    && a.project_path === b.project_path
    && a.git_root === b.git_root
    && a.model === b.model
    && a.effort === b.effort
    && a.stable_mode === b.stable_mode
    && JSON.stringify(a.stable_exclude ?? []) === JSON.stringify(b.stable_exclude ?? []);
}

function pendingLaunchReconfigure(row: any): Record<string, any> | null {
  const requested = row?._launchSnapshot as SessionLaunchSnapshot | undefined;
  if (!requested) return null;
  const latest = launchSnapshotFromRow(row);
  if (launchSnapshotsEqual(requested, latest)) return null;
  const agentType = latest.agent_type || requested.agent_type || "claude_code";
  const model = modelOptionKey(latest.model ?? undefined, agentType);
  return {
    agent_type: agentType,
    ...(latest.project_path !== undefined ? { project_path: latest.project_path } : {}),
    ...(latest.git_root !== undefined ? { git_root: latest.git_root } : {}),
    // Explicit defaults clear a launch pin that was selected when the parked
    // create was first enqueued and then removed on the still-local stub.
    model,
    effort: latest.effort || "default",
    ...(latest.stable_mode ? { stable_mode: latest.stable_mode } : {}),
    ...(latest.stable_exclude?.length ? { stable_exclude: latest.stable_exclude } : {}),
  };
}

// Coalesce the normal caller continuation with the rekey safety net. The
// caller sends in a promise microtask after resolveSessionId; the fallback runs
// on the next task. A short in-memory window prevents a second outbox entry in
// that healthy path, while a reload intentionally forgets it and safely
// re-drives by client_id (the server deduplicates that id).
const recentlyRequestedPendingMessages = new Map<string, number>();
const PENDING_MESSAGE_REDRIVE_COALESCE_MS = 5_000;
const resolvedSessionPreparations = new Map<string, Promise<void>>();

function notePendingMessageSendRequested(clientId?: string): void {
  if (!clientId) return;
  const now = Date.now();
  recentlyRequestedPendingMessages.set(clientId, now);
  if (recentlyRequestedPendingMessages.size <= 500) return;
  for (const [id, at] of recentlyRequestedPendingMessages) {
    if (now - at > PENDING_MESSAGE_REDRIVE_COALESCE_MS) {
      recentlyRequestedPendingMessages.delete(id);
    }
  }
}

// The send args a pending optimistic row stands for, for any path that re-issues
// its send (rekey redrive, boot redrive, the bubble's Retry). Replays the exact
// bytes the original send dispatched: the server dedupes this client id by
// argument fingerprint, so a rebuilt payload (raw content without the
// mention-expansion context, or the same text without its images) is refused
// as COMMAND_ID_REUSED. `uploading` means an image has no storage id yet: the
// detached upload task that owns the row sends it once the upload settles, so
// no other path may send first — the server keeps the first row per client id,
// and a send that beats the upload lands the message without its image for good.
export function pendingRowSendArgs(message: Message): { content: string; imageIds: string[] | undefined; uploading: boolean } {
  const content = message._dispatchContent || message.content || "";
  const images = message.images || [];
  const imageIds = images
    .map((image: any) => image?.storage_id)
    .filter((id: unknown): id is string => typeof id === "string");
  return {
    content,
    imageIds: imageIds.length ? imageIds : undefined,
    uploading: images.some((image: any) => image?.uploading),
  };
}

function redrivePendingMessagesFor(convexId: string): void {
  const store = useInboxStore.getState();
  for (const message of store.pendingMessages[convexId] || []) {
    if (message._isFailed) continue;
    const clientId = message._clientId || message._id;
    const requestedAt = recentlyRequestedPendingMessages.get(clientId);
    if (requestedAt && Date.now() - requestedAt < PENDING_MESSAGE_REDRIVE_COALESCE_MS) continue;
    const { content, imageIds, uploading } = pendingRowSendArgs(message);
    if (uploading) continue;
    if (!content.trim() && !imageIds) continue;
    store.sendMessage(convexId, content, imageIds, clientId);
  }
}

function resumePostCreateBucketIntentFor(
  convexId: string,
  explicitBucketId?: string,
): void {
  if (!isConvexId(convexId)) return;
  const store = useInboxStore.getState();
  const bucketId = store.sessions[convexId]?._postCreateBucketId
    ?? (store.conversations[convexId] as any)?._postCreateBucketId;
  if (!bucketId) return;
  // A Promise continuation captured when the session was first summoned can
  // run after the user has moved it elsewhere (or a later summon superseded
  // the focused bucket). The persisted marker is the current intent; never let
  // a stale closure recreate an older filing after that marker changed.
  if (explicitBucketId && explicitBucketId !== bucketId) return;

  const assignment = (Object.values(store.bucketAssignments) as BucketAssignmentItem[])
    .find((row) => row.conversation_id === convexId);
  if (assignment && isConvexId(String(assignment._id))) {
    // Any authoritative row is newer proof than this create-time marker. It may
    // match the original bucket, or it may represent a later manual move/unfile
    // from this or another client. In either case the one-shot intent is spent.
    store._clearPostCreateBucketIntent(convexId, bucketId);
    return;
  }
  // The assignment action is durable and the server upsert is idempotent. Keep
  // the marker until an authoritative (Convex-id-keyed) assignment echo lands,
  // so a crash between this call and its outbox commit merely retries.
  store.assignSessionToBucket(convexId, bucketId);
}

function scheduleResolvedSessionContinuations(
  convexId: string,
  launchReconfigure: Record<string, any> | null,
): void {
  const prepare = new Promise<void>((resolve) => {
    setTimeout(() => {
      void (async () => {
        // If the user changed launch controls after createSession was durably
        // parked, its frozen outbox args are stale. Reconfigure the still-blank
        // real session before releasing any first-message waiter.
        if (launchReconfigure) {
          try {
            await useInboxStore.getState().convCommand(
              convexId,
              "reconfigureSession",
              launchReconfigure,
            );
          } catch (error) {
            if (!isParkedDispatchError(error)) {
              console.error("[sync] failed to reconcile parked session launch preferences", error);
            }
          }
        }

        // Generic action() edits made while the row still had a stub id were
        // protected in `pending`, but groupPatchesByTable correctly refused to
        // send a non-Convex document id. Flush those exact latest values now
        // through a named durable action (the old raw _dispatch could vanish).
        const state = useInboxStore.getState();
        resumePostCreateBucketIntentFor(convexId);
        const prefix = `conversations:${convexId}:`;
        const fields: Record<string, any> = {};
        for (const [key, entry] of Object.entries(state.pending || {})) {
          if ((entry as any).type !== "field" || !key.startsWith(prefix)) continue;
          fields[key.slice(prefix.length)] = (entry as any).value;
        }
        if (Object.keys(fields).length > 0) {
          state.flushResolvedSessionFields(convexId, fields);
        }
      })().finally(() => {
        resolve();
        // A create dispatched while unwired rejects its in-memory Promise
        // honestly, so a caller may have stopped awaiting before the
        // by_session_id row arrived. Run the persisted-message fallback one
        // task AFTER preparation: a healthy awaitConvexId caller resumes in the
        // intervening microtask, sends normally, and records its clientId.
        setTimeout(() => {
          redrivePendingMessagesFor(convexId);
        }, 0);
      });
    }, 0);
  });
  resolvedSessionPreparations.set(convexId, prepare);
  void prepare.then(() => {
    if (resolvedSessionPreparations.get(convexId) === prepare) {
      resolvedSessionPreparations.delete(convexId);
    }
  });
}

async function awaitResolvedSessionPreparation(convexId: string): Promise<void> {
  await resolvedSessionPreparations.get(convexId);
}

/**
 * A channel create has just been superseded by its server row. Anything typed
 * into the channel while the create was in flight was dispatched with the STUB
 * channel id, and the dispatch handler refuses a stub — a refusal the outbox
 * reads as success, so it retired the entry and nothing will ever re-drive it.
 * The message would sit on screen as "pending" forever.
 *
 * Same hook, same shape and the same reason as scheduleResolvedSessionContinuations:
 * a timer, so the continuation observes the rekeyed store and dispatch stays out
 * of the incoming-data transaction. retryChatSend re-dispatches under the SAME
 * client id, which chat.sendMessage dedupes on, so a message that did somehow
 * land cannot double-post.
 */
function scheduleResolvedChatChannelSends(channelId: string): void {
  setTimeout(() => {
    const state = useInboxStore.getState();
    const messages = state.chatMessages || {};
    for (const id in messages) {
      const row = messages[id];
      if (!row || row.channel_id !== channelId || isConvexId(row._id)) continue;
      state.retryChatSend(row._id);
    }
    // The read row was written under the stub too, so the server has never been
    // told this viewer joined and read the channel they just created.
    const marker = selectChannelReadMarker(state as any, channelId);
    state.markChannelRead(channelId, marker?._id);
  }, 0);
}

function rekeyId(draft: any, oldId: string, newId: string) {
  if (oldId === newId) return;
  if (draft.sessions[oldId]) {
    draft.sessions[newId] = { ...draft.sessions[oldId], _id: newId };
    delete draft.sessions[oldId];
  }
  if (draft.messages[oldId]) {
    draft.messages[newId] = draft.messages[oldId];
    delete draft.messages[oldId];
  }
  if (draft.pendingMessages[oldId]) {
    draft.pendingMessages[newId] = draft.pendingMessages[oldId];
    delete draft.pendingMessages[oldId];
  }
  if (draft.pagination[oldId]) {
    draft.pagination[newId] = draft.pagination[oldId];
    delete draft.pagination[oldId];
  }
  if (draft.drafts[oldId]) {
    draft.drafts[newId] = draft.drafts[oldId];
    delete draft.drafts[oldId];
  }
  if (draft.clientState.drafts?.[oldId]) {
    draft.clientState.drafts[newId] = draft.clientState.drafts[oldId];
    draft.clientState.drafts[oldId] = null;
  }
  if (draft.conversations[oldId]) {
    draft.conversations[newId] = { ...draft.conversations[oldId], _id: newId };
    delete draft.conversations[oldId];
  }
  if (draft.currentSessionId === oldId) {
    // Same logical conversation under its server-assigned id — not a jump.
    declareViewNav("rekey");
    draft.currentSessionId = newId;
  }
  // Pure id correction (stub → real), not a position move: bypasses the
  // foreground gate but only ever rewrites a pointer already at oldId.
  if (draft.clientState.current_conversation_id === oldId) {
    draft.clientState.current_conversation_id = newId;
  }
  if (draft.lastFocusedConversationId === oldId) {
    draft.lastFocusedConversationId = newId;
  }
  if (draft.currentConversation?.conversationId === oldId) {
    draft.currentConversation.conversationId = newId;
  }
  if (draft.sidePanelSessionId === oldId) {
    draft.sidePanelSessionId = newId;
  }
  // Label filing follows the conversation across the rekey: the assignment row
  // is what groups the session in the bucketed list, and the altKey supersede
  // matches on conversation_id — a row left pointing at the dead stub id would
  // ungroup the session AND orphan as an immortal stub.
  for (const row of Object.values(draft.bucketAssignments || {}) as BucketAssignmentItem[]) {
    if (row.conversation_id === oldId) row.conversation_id = newId;
  }
  // A tab persists its session as a `?s=<id>` path (and AppTab.sessionId). Left
  // pointing at the dead stub, the inbox's re-assert effect would chase a session
  // that no longer exists — the same param/currentSession drift, just born from a
  // create instead of an in-pane click.
  for (const t of draft.tabs) {
    if (t.sessionId === oldId) t.sessionId = newId;
    if (t.path === `/inbox?s=${oldId}`) t.path = `/inbox?s=${newId}`;
    else if (t.path === `/conversation/${oldId}`) t.path = `/conversation/${newId}`;
    // A newly created channel is navigated to by its stub id, because the rail
    // can select it before the server has answered. The tab path is the app's
    // real router (TabContent), and TabPane re-stamps window.location from it,
    // so rewriting it here is what stops the reader sitting on a dead
    // /chat/chatstub-… while their channel lives beside it under its real id.
    else if (t.path === `/chat/${oldId}` || t.path.startsWith(`/chat/${oldId}?`)) {
      t.path = `/chat/${newId}${t.path.slice(`/chat/${oldId}`.length)}`;
    }
  }
  // The parent's branch-map chip for an optimistic fork follows the rekey too.
  // This matters on the altKey-supersede path (a parked fork create that lands
  // via the outbox never runs resolveForkSessionId): left keyed by the dead
  // stub id, the chip can't be pruned against server fork_children and
  // dead-ends when clicked.
  if (Array.isArray(draft.optimisticForkChildren)) {
    for (const f of draft.optimisticForkChildren) {
      if (f._id === oldId) f._id = newId;
    }
  }
  // Chat rows point at each other by id: messages and reactions name their
  // channel, replies name their thread root. When a channel stub or a message
  // stub is superseded by its server row, everything pointing at the dead stub id
  // has to follow, or the messages typed while the create was in flight orphan
  // under an id no query will ever return. Same rule as the bucket assignment
  // above, applied to the three chat collections that carry a reference.
  if (draft.chatMessages) {
    for (const id in draft.chatMessages) {
      const row = draft.chatMessages[id];
      if (row.channel_id === oldId) row.channel_id = newId;
      if (row.thread_root_id === oldId) row.thread_root_id = newId;
    }
  }
  if (draft.chatReactions) {
    for (const id in draft.chatReactions) {
      if (draft.chatReactions[id].channel_id === oldId) draft.chatReactions[id].channel_id = newId;
    }
  }
  if (draft.chatReads) {
    for (const id in draft.chatReads) {
      if (draft.chatReads[id].channel_id === oldId) draft.chatReads[id].channel_id = newId;
    }
  }
}

// Record "where the user is" in two places with one gate:
//
// - `lastFocusedConversationId` — THIS client's own memory, persisted locally
//   (IDB meta), never synced. It is the boot-restore source: each client
//   returns to its own last position, so no other client can teleport it.
// - `clientState.current_conversation_id` — the per-user synced pointer, one
//   value raced by every client (other devices, agent-driven tabs). Consulted
//   only by clients with no local history (fresh profile), where adopting a
//   wrong value is harmless.
//
// Only a client the user is actually looking at may write either. Restore and
// navigation funnel through the same actions, so an unfocused client
// (vite-reloaded background tab, agent/automation-driven tab) would otherwise
// echo whatever it restored; with N background tabs that outvotes the user's
// real position after every dev-server reload. Focus is not a perfect "real
// user" signal — an agent driving a frontmost Chrome window passes it — which
// is exactly why restore prefers the local field (the desktop app's Electron
// profile shares nothing with Chrome). The palette popup is its own
// always-focused window, so it is excluded explicitly — summoning it must not
// repoint the user's other clients at the pre-warmed blank session. On native
// (no `document`) the running app is by definition what the user is looking at.
function recordCurrentConversationPointer(
  draft: {
    clientState: { current_conversation_id?: string };
    lastFocusedConversationId?: string | null;
  },
  id: string | undefined,
) {
  if (typeof document !== "undefined") {
    if (!document.hasFocus()) return;
    if (typeof window !== "undefined" && window.location?.pathname?.startsWith("/palette")) return;
  }
  draft.clientState.current_conversation_id = id;
  draft.lastFocusedConversationId = id ?? null;
}

// Keep the active inbox tab's stored `?s=` in lockstep with the session it shows.
// That path is the source of `paramSessionId` in the inbox (QueuePageClient reads
// it through the per-tab navigation context). In-pane session selection used to
// write currentSessionId + the browser URL but NEVER the tab path, so the two
// drifted; the inbox's "re-assert my tab's session" effect then snapped the view
// back to the stale param on every sessions heartbeat (~4s). Aligning the path
// here makes that effect a no-op and lets a tab remember an in-pane navigation
// across a tab switch. Only inbox tabs carry `?s=`; /tasks, /docs, etc. are left
// untouched.
function syncActiveInboxTabPath(draft: Draft, id: string | null) {
  const tabId = draft.activeTabId;
  if (!tabId) return;
  const tab = draft.tabs.find((t) => t.id === tabId);
  if (!tab || tab.path.split("?")[0] !== "/inbox") return;
  // A null selection (dismissed the last session) clears the param to a bare
  // /inbox, so the re-assert effect reads no target instead of `?s=null`.
  const next = id ? `/inbox?s=${id}` : "/inbox";
  if (tab.path === next) return;
  draft.tabs = draft.tabs.map((t) => (t.id === tabId ? { ...t, path: next } : t));
}

// The single "I am now viewing `id`" commit, shared by every navigation primitive
// (setCurrentSession / injectSession / navigateToSession). Records the view for
// the new-divider anchor, moves the current pointer, drops any dismissed-peek,
// mirrors the per-user pointer, and keeps the active inbox tab's param aligned.
// Callers still own declareViewNav() — the view-nav source differs per path.
function commitCurrentSession(draft: Draft, id: string) {
  recordSessionView(draft, id, draft.currentSessionId);
  draft.currentSessionId = id;
  draft.viewingDismissedId = null;
  recordCurrentConversationPointer(draft, id);
  syncActiveInboxTabPath(draft, id);
}

// Shared body of the dismissed/stashed reconciles. Overlays the server's
// CURRENT hidden set (within the window) onto the never-prune cache:
//   SET   — a cached session the server reports hidden (heals a hide made
//           while this device was offline; the updated_at-keyed session crawl
//           can never carry it).
//   CLEAR — (final pass only) a session we have flagged hidden WITHIN the
//           window that the server no longer reports = un-hidden elsewhere.
// Both passes skip ids with a pending field override so an in-flight local
// hide/restore on THIS device always wins (local-first). Per-page calls pass
// final=false (SET only); the final whole-set call passes true (SET + CLEAR),
// because CLEAR needs the complete set or a row on a later page would be
// wrongly un-hidden.
// How long a hide/un-hide field override keeps outranking the server's
// authoritative hidden set. The override exists to protect an IN-FLIGHT local
// change; its dispatch settles within seconds. Past this, a disagreement with
// the reconcile crawl means the value was overturned elsewhere (another
// device, or a server-side restore) — and since hidden rows leave the live
// channel, no echo will ever arrive to clear the override. Without this
// release the originating device pins the row hidden FOREVER (ct-36973).
export const HIDDEN_OVERRIDE_SETTLE_MS = 5 * 60 * 1000;

function applyHiddenReconcileInDraft(
  draft: any,
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  entries: Array<{ _id: string } & Record<string, any>>,
  final: boolean,
) {
  const server = new Map<string, number | null>();
  for (const e of entries) server.set(e._id, e[field] ?? null);
  // A bridge hide stamps its visible hide field with the SAME timestamp used
  // for every coupled pending lock. Hidden rows never return through normal
  // sessions sync, so this lightweight hidden-set row is the only production
  // acknowledgement those pin/no-op locks can receive. Match the explicit
  // hide acknowledgement anchor rather than lock `ts`: the acting window's
  // auto-pending freshness clock can be sampled after its hide value. An older
  // or otherwise stale hidden result must leave every lock intact.
  const retireAcknowledgedHide = (id: string, ts: number) => {
    const anchors = ["sessions", "conversations"].map((coll) => draft.pending[`${coll}:${id}:${field}`]);
    const matches = anchors.some((entry: any) =>
      entry?.type === "field" && entry.hideAck === ts,
    );
    if (!matches) return false;
    for (const coll of ["sessions", "conversations"]) {
      for (const coupled of ["inbox_dismissed_at", "inbox_stashed_at", "inbox_pinned_at", "is_pinned"]) {
        const key = `${coll}:${id}:${coupled}`;
        if (draft.pending[key]?.type === "field" && draft.pending[key].hideAck === ts) delete draft.pending[key];
      }
    }
    return true;
  };
  // Locked = a pending field override is still inside its settle window.
  // Stale overrides are released (deleted) so the authoritative set can land.
  const lockedLocal = (id: string) => {
    const keys = [`sessions:${id}:${field}`, `conversations:${id}:${field}`];
    const entries = keys.map((k) => draft.pending[k]).filter(Boolean);
    if (entries.length === 0) return false;
    // An entry without a timestamp can't be dated — keep protecting it.
    const newest = Math.max(...entries.map((e: any) => e.ts ?? Infinity));
    if (Date.now() - newest < HIDDEN_OVERRIDE_SETTLE_MS) return true;
    for (const k of keys) delete draft.pending[k];
    return false;
  };

  for (const [id, ts] of server) {
    if (ts) retireAcknowledgedHide(id, ts);
    if (!ts || lockedLocal(id)) continue;
    const sess = draft.sessions[id];
    if (sess && sess[field] !== ts) sess[field] = ts;
    const conv = draft.conversations[id];
    if (conv && conv[field] !== ts) conv[field] = ts;
  }

  if (!final) return;

  const cutoff = Date.now() - DISMISS_RECONCILE_WINDOW_MS;
  for (const id of Object.keys(draft.sessions)) {
    // Local-only stub ids can never be in the server's hidden set, so its
    // silence about them carries no signal — clearing here would resurrect a
    // hidden orphaned stub on every crawl, forever.
    if (!isConvexId(id)) continue;
    const sess = draft.sessions[id];
    const at = sess[field];
    if (!at || at < cutoff || server.has(id) || lockedLocal(id)) continue;
    // A BLANK row leaving the server's hidden set usually means the
    // empty-conversation GC hard-deleted it — un-hiding would resurrect
    // a ghost "New Session" card into the active inbox. Leave it hidden;
    // the verified ghost sweep (pruneGhostSessions) removes it, and a real
    // remote restore re-arrives via the live channel.
    if ((sess.message_count ?? 0) === 0 && !sess.has_pending) continue;
    sess[field] = null;
    const conv = draft.conversations[id];
    if (conv) conv[field] = null;
  }

  // A direct conversation view (and markKilling) can retain metadata after its
  // inbox row is absent. SET already updates that conversation-only twin, so a
  // complete hidden-set pass must clear it symmetrically on a remote restore.
  // There is no inbox card here, so the session-only blank-GC guard does not
  // apply; clearing metadata cannot resurrect a row into the inbox.
  for (const id of Object.keys(draft.conversations)) {
    if (draft.sessions[id] || !isConvexId(id)) continue;
    const conv = draft.conversations[id];
    const at = conv[field];
    if (!at || at < cutoff || server.has(id) || lockedLocal(id)) continue;
    conv[field] = null;
  }
}

// Shared body of stashSession/killSession: hide `id` (and its nested
// children) out of the active buckets, advancing the current selection past the
// removed set. Stash writes inbox_stashed_at; dismiss writes inbox_dismissed_at
// and clears any stash (the row MOVES to Dismissed — the buckets are exclusive).
//
// Returns the two resolved id sets so the calling action can announce them on
// the cross-window gesture bridge (gestureBridge.ts): `hidden` are the rows
// that got a hide timestamp, `forgotten` the rows deleted outright. Only this
// function knows the cascade (nested children) and which members turned out to
// be stubs/foreign, so returning them is the least invasive way to surface it —
// the action body must NOT return them onward, since an action()'s return value
// becomes its server dispatch payload.
//
// `now` is the gesture's timestamp. Bulk kill passes ONE for the whole sweep so
// every row it stamps carries the same value its single broadcast does — a
// per-row Date.now() drifts across a long sweep, and a receiver's field lock
// holding a value the server never echoes back never retires.
function hideSessionInDraft(
  draft: any,
  id: string,
  mode: "stash" | "kill",
  now: number = Date.now(),
): { hidden: string[]; forgotten: string[]; ts: number } {
  const field = mode === "kill" ? "inbox_dismissed_at" : "inbox_stashed_at";
  const sessionValues = Object.values(draft.sessions) as InboxSession[];
  // The removed set must match what the card visually contains, so the sweep
  // uses the SAME nesting definition the renderer does (nestParentIdOf): Task
  // subagents (parent_conversation_id) AND agent-team teammates (spawned_by +
  // team). Sweeping only parent_conversation_id left a killed lead's teammates
  // behind as loose top-level needs-input cards — a teammate with an absent
  // lead deliberately floats first-class, so the categorizer can't hide it;
  // the cascade is the only place the group can be taken down together.
  const childIds = sessionValues
    .filter((s) => s._id !== id && nestParentIdOf(s) === id)
    .map((s) => s._id);
  const allIds = [id, ...childIds];
  // The viewer. A session whose user_id isn't ours was injected into this cache
  // by viewing/searching a TEAMMATE's session — we can't durably hide it.
  const me = draft.currentUser?._id?.toString?.();
  const hidden: string[] = [];
  const forgotten: string[] = [];
  let newSessionId = draft.currentSessionId;
  if (draft.currentSessionId && allIds.includes(draft.currentSessionId)) {
    // Advance in the order the user is LOOKING at (active view mode, same as
    // j/k), not the default grouped layout's order.
    const next = nextSessionPastRemoved(computeVisualOrder(draft), draft.currentSessionId, new Set(allIds));
    newSessionId = next?._id ?? null;
  }
  for (const sid of allIds) {
    // A local-only stub (optimistic create that never landed server-side)
    // can't be hidden durably: the server never knew it, so the reconcile's
    // CLEAR pass would un-hide it on every crawl once the pending lock is
    // lost (it's clobbered wholesale by other windows sharing the IDB).
    // Hiding it honestly means deleting it — store + IDB (the auto-generated
    // exclude pending persists the row delete, as with kills).
    //
    // A TEAMMATE'S session is the same situation: the server's applyPatches
    // owner-gate (dispatch.ts) silently DROPS a hide patch on a conversation we
    // don't own, so inbox_stashed_at/inbox_dismissed_at never persists, the
    // 5-min optimistic lock lapses, and the reconcile clear pass resurrects it
    // into the active inbox. Stash/kill on a foreign session can only mean
    // "forget my injected copy" — it returns iff we reopen it. Ownership MUST
    // resolve through isForeignSession: a thin injected row often carries no
    // user_id at all, and only conversations[sid].is_own knows whose it is.
    const ownerSess = draft.sessions[sid];
    const isForeign = !!ownerSess && isForeignSession(ownerSess, draft.conversations[sid], me);
    if (!isConvexId(sid) || isForeign) {
      delete draft.sessions[sid];
      delete draft.conversations[sid];
      delete draft.messages[sid];
      delete draft.pendingMessages[sid];
      forgotten.push(sid);
      continue;
    }
    hidden.push(sid);
    const sess = draft.sessions[sid];
    const wasPinned = sess?.is_pinned;
    if (sess) {
      sess[field] = now;
      if (mode === "kill" && sess.inbox_stashed_at) sess.inbox_stashed_at = null;
      if (wasPinned) {
        sess.is_pinned = false;
        sess.inbox_pinned_at = null;
      }
    }
    const conv = draft.conversations[sid];
    if (conv) {
      conv[field] = now;
      if (mode === "kill" && conv.inbox_stashed_at) conv.inbox_stashed_at = null;
      if (wasPinned) conv.inbox_pinned_at = null;
    }
  }
  // Dismiss-and-advance: every caller of hideSessionInDraft is a user
  // stash/kill/dismiss, so moving to the next session is gesture-class.
  declareViewNav("gesture");
  draft.currentSessionId = newSessionId;
  recordCurrentConversationPointer(draft, newSessionId ?? undefined);
  // Keep the active inbox tab's `?s=` in lockstep with the advanced selection,
  // exactly as commitCurrentSession does for normal navigation. Without this the
  // tab path stays pointed at the just-hidden session, and the inbox's re-assert
  // effect snaps the view back onto it (resurfacing the dismissed/killed session
  // as a peek) the next time it runs — e.g. when the tab is re-activated.
  syncActiveInboxTabPath(draft, newSessionId);
  return { hidden, forgotten, ts: now };
}

// The focused session fell out of the list the panel renders — a filter changed
// under it, so nothing was hidden, the view simply stopped containing it. The
// highlight cannot stay on a row that isn't there, so it lands on the top of the
// new order: the row Ctrl+J would walk to first. An emptied order clears the
// pointer the same way a dismiss-and-advance with nothing left to advance to
// does. WHICH pointer is the rail's own three-way answer (sessionFocusKind) —
// the working pages highlight currentSessionId like the inbox, so treating them
// as "not the inbox" wrote the dead sidePanelSessionId and left the highlighted
// row stranded outside the list.
function evictFocusOutsideOrderInDraft(draft: Draft, focusKind: SessionFocusKind) {
  const usesPanel = focusKind === "panel";
  const focusedId = usesPanel ? draft.sidePanelSessionId : (draft.viewingDismissedId ?? draft.currentSessionId);
  if (!focusedId) return;
  const ordered = computeVisualOrder(draft);
  if (ordered.some((s) => s._id === focusedId)) return;
  const top = ordered[0]?._id ?? null;
  if (usesPanel) {
    draft.sidePanelSessionId = top;
    return;
  }
  declareViewNav("gesture");
  if (top) {
    commitCurrentSession(draft, top);
    return;
  }
  draft.currentSessionId = null;
  draft.viewingDismissedId = null;
  recordCurrentConversationPointer(draft, undefined);
  syncActiveInboxTabPath(draft, null);
}

// The surface on screen, as the store can see it: the active tab's path is what
// usePathname() reports inside the shell; outside tab routing (a detached
// window) it is the real location. Lets the chip setters evict focus without
// every caller threading a pathname through.
function mountedPathname(draft: Draft): string | undefined {
  const tab = draft.activeTabId ? draft.tabs.find((t) => t.id === draft.activeTabId) : undefined;
  // Tab paths keep their query (/inbox?s=…); the surface helpers want the bare
  // pathname, as usePathname reports it.
  if (tab) return tab.path.split("?")[0];
  return typeof window !== "undefined" ? window.location.pathname : undefined;
}

// One chip filter changed: record it for Back, and if the focused session just
// left the rendered list, move focus the same way a layout switch does — the
// two are the same gesture at different sizes, so they must not disagree.
function commitChipFilterChange(draft: Draft, prev: InboxViewSnapshot) {
  const next = snapshotInboxViewFromDraft(draft);
  if (sameInboxView(prev, next)) return;
  pushInboxViewHistory(prev, next);
  evictFocusOutsideOrderInDraft(draft, sessionFocusKind(mountedPathname(draft), draft.currentConversation?.source));
}

// The signed-in user, as the gesture bridge stamps it on outbound messages and
// matches it on inbound ones. Exported for undoActions, whose undo closures
// broadcast the reverted value (an un-announced undo leaves a sibling holding
// the pre-undo row — see gestureBridge.ts).
export function bridgeUserId(state: any): string | null {
  return state.currentUser?._id?.toString?.() ?? null;
}

// The bridged subset of a generic field patch, or null if it touches none of
// them. Values pass through verbatim so the receiver's planted locks hold
// exactly what the sender dispatched (see applyGestureInDraft's `write`).
function pickBridgedFields(
  fields: Record<string, any>,
): Partial<Record<BridgedField, number | boolean | null>> | null {
  let out: Partial<Record<BridgedField, number | boolean | null>> | null = null;
  for (const field of BRIDGED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const value = fields[field];
    if (value !== null && typeof value !== "number" && typeof value !== "boolean") continue;
    out ??= {};
    out[field] = value;
  }
  return out;
}

// Sender half for the hide gestures. Called from inside the action body (the
// mutative recipe), alongside soundDismiss/soundKill — the local mutation is
// already fully computed on the draft at this point and lands synchronously
// when the middleware commits it, so a sibling can never observe the broadcast
// "before" this window's own state change.
function announceHide(
  draft: any,
  mode: "stash" | "kill",
  result: { hidden: string[]; forgotten: string[]; ts: number },
) {
  if (result.hidden.length === 0 && result.forgotten.length === 0) return;
  broadcastGesture(
    {
      kind: "hide",
      mode,
      ids: result.hidden,
      ...(result.forgotten.length ? { forget: result.forgotten } : {}),
      ts: result.ts,
    },
    bridgeUserId(draft),
  );
}

// Receiver half of the cross-window gesture bridge (see gestureBridge.ts for
// the clobber mechanism this defends against). Applies a SIBLING window's
// gesture to this window's in-memory rows, so this window's next whole-row IDB
// put carries the gesture instead of writing the pre-gesture row back over it.
//
// Deliberately narrow — fields and row removal only. It never touches
// currentSessionId, the tab path, or any navigation state: the user is looking
// at THIS window, and a dismiss they made in another one must not move their
// view here. It runs under sync(), so it neither dispatches nor enqueues an
// outbox entry; the acting window owns the single server write.
//
// Every write is timestamp-guarded so a late, duplicated, or reordered message
// can never regress newer local state. An absent visible value counts as 0, but
// a pending field lock still carries the timestamp of a newer restore/unpin.
function applyGestureInDraft(draft: any, msg: GestureMessage) {
  const notNewer = (coll: "sessions" | "conversations", id: string, field: string, current: unknown, ts: number) => {
    const pending = draft.pending[`${coll}:${id}:${field}`];
    const currentTs = typeof current === "number" ? current : 0;
    const pendingTs = pending?.type === "field" && typeof pending.ts === "number" ? pending.ts : 0;
    return Math.max(currentTs, pendingTs) <= ts;
  };
  // A bridged gesture changes the session row and its conversation twin as one
  // transition. Accept only when every extant twin agrees it is not older; a
  // per-twin decision can otherwise leave one row moved and the other behind.
  const transitionNotNewer = (id: string, fields: string[], ts: number) =>
    (["sessions", "conversations"] as const).every((coll) => {
      const row = draft[coll][id];
      return !row || fields.every((field) => notNewer(coll, id, field, row[field], ts));
    });

  // Write a field AND plant the pending field lock the sender's action() gets
  // for free from generateAutoPending (mutativeMiddleware). The lock is not
  // bookkeeping — it is the only thing that makes the bridged value survive:
  //   • applySyncTable's applyFieldOverrides re-asserts it over an incoming
  //     server row (delta mode replaces the row wholesale), and
  //   • applyHiddenReconcileInDraft's SET/CLEAR passes skip a locked row
  //     (lockedLocal).
  // Without it, a sessions crawl already in flight in THIS window — a wake
  // reconcile pages for seconds — lands the pre-gesture server row, the bridged
  // hide silently vanishes, and this window's next whole-row put writes the
  // un-hidden row over the acting window's in shared IDB. That is precisely the
  // bug the bridge exists to prevent, so an unlocked apply is worse than none.
  //
  // This does NOT breach the receiver's no-server-write contract: {type:"field"}
  // pendings are consumed only by the local sync appliers (applySyncTable,
  // applySyncRecord, applyHiddenReconcileInDraft). They are never dispatched and
  // never enqueued — only action()/asyncAction() reach the outbox.
  //
  // The planted value must equal the transition's post-state, because the lock
  // retires only when the server echo matches it (applyFieldOverrides).
  const write = (
    coll: "sessions" | "conversations",
    id: string,
    field: string,
    value: any,
    hideAck?: number,
  ) => {
    const row = draft[coll][id];
    if (!row) return;
    if (row[field] !== value) row[field] = value;
    draft.pending[`${coll}:${id}:${field}`] = { type: "field", value, ts: msg.ts, ...(hideAck !== undefined ? { hideAck } : {}) };
  };

  // An accepted gesture is one causal transition, even if every visible value
  // already matches.  Record fresh locks for all of its constrained fields
  // before returning to a branch-specific effect.  Otherwise an undo pin that
  // restores the old pinnedAt payload, for example, leaves an old visible stamp
  // and lets a delayed hide incorrectly win.
  const acceptTransition = (
    id: string,
    constrained: string[],
    changes: {
      shared?: Record<string, any>;
      sessions?: Record<string, any>;
      conversations?: Record<string, any>;
    },
    hideAck?: number,
  ) => {
    if (!transitionNotNewer(id, constrained, msg.ts)) return false;
    for (const coll of ["sessions", "conversations"] as const) {
      const row = draft[coll][id];
      if (!row) continue;
      const next = {
        ...changes.shared,
        ...(changes[coll] ?? {}),
      };
      // A coupled field the message does not visibly change still takes part
      // in its ordering barrier. Lock its retained value at this transition's
      // timestamp so a delayed coupled gesture cannot cross the barrier.
      for (const field of constrained) {
        if (!Object.prototype.hasOwnProperty.call(next, field)) next[field] = row[field];
      }
      for (const [field, value] of Object.entries(next)) write(coll, id, field, value, hideAck);
    }
    return true;
  };

  const forget = (ids: string[], ts: number, scope: "session-row" | "all" = "all") => {
    for (const fid of ids) {
      // Mirror ALL of pruneGhostSessions' IN-USE guards, not just the first.
      // (Its skip for a row this window doesn't hold does NOT carry over: there
      // the absence means no evidence, here the sender is the evidence, and the
      // exclude is what stops an in-flight crawl re-adding what it just deleted.)
      // Declining only ever makes the receiver more conservative — the sender
      // still owns its own durable delete — while deleting here would destroy
      // state this window knows about and the sender did not:
      //   • currentSessionId: the conversation view would blank out mid-read.
      //   • pendingMessages: unsent user TEXT queued in this window.
      //   • pendingSessionCreates: a create still in flight, about to rekey.
      if (draft.currentSessionId === fid) continue;
      if (draft.pendingMessages[fid]?.length) continue;
      if (fid in draft.pendingSessionCreates) continue;
      delete draft.sessions[fid];
      // The exclude is what authorizes the durable IDB row delete — a bare
      // store-shrink is ignored by the collection diff (same reason
      // pruneGhostSessions plants them) — and it also stops a delta crawl from
      // re-adding the row this window was just told is gone.
      draft.pending[`sessions:${fid}`] = { type: "exclude", ts };
      // markKilling drops the inbox CARD but keeps the conversation cached (the
      // server still has it, marked completed). Mirroring that exactly matters:
      // an exclude planted here for a conversation that still exists would
      // blind this window to it on every later crawl.
      if (scope === "session-row") continue;
      delete draft.conversations[fid];
      delete draft.messages[fid];
      delete draft.pendingMessages[fid];
      delete draft.pagination[fid];
      draft.pending[`conversations:${fid}`] = { type: "exclude", ts };
    }
  };

  if (msg.kind === "forget") {
    forget(msg.ids, msg.ts, msg.scope ?? "all");
    return;
  }

  if (msg.kind === "hide") {
    // A mixed cascade (real rows flagged, stubs/foreign rows deleted) rides
    // ONE message, so the deletions are applied here rather than as a separate
    // forget broadcast — see gestureBridge.ts.
    if (msg.forget?.length) forget(msg.forget, msg.ts);
    const field = msg.mode === "kill" ? "inbox_dismissed_at" : "inbox_stashed_at";
    for (const sid of msg.ids) {
      if (!acceptTransition(sid, ["inbox_dismissed_at", "inbox_stashed_at", "inbox_pinned_at"], {
        shared: {
          [field]: msg.ts,
          ...(msg.mode === "kill" ? { inbox_stashed_at: null } : {}),
          inbox_pinned_at: null,
        },
        // Both hide modes move the row out of Pinned. Mirrors
        // hideSessionInDraft, which clears a pre-existing pin for stash too.
        sessions: { is_pinned: false },
      }, msg.ts)) continue;
    }
    return;
  }

  if (msg.kind === "restore") {
    // Un-hiding is un-hiding: all three flags clear, but only if this window's
    // value is no newer than the restore (a re-kill here must survive).
    // inbox_killed_at rides along for the same reason the sender clears it
    // (restoreSession): a command-killed row carries the marker alone, and a
    // sibling that cleared only the two hide stamps would go on hiding it.
    for (const sid of msg.ids) {
      // A no-op restore still carries a newer causal tombstone. Without these
      // locks, a delayed older kill sees visible nulls and re-applies.
      acceptTransition(sid, ["inbox_dismissed_at", "inbox_stashed_at", "inbox_killed_at"], {
        shared: { inbox_dismissed_at: null, inbox_stashed_at: null, inbox_killed_at: null },
      });
    }
    return;
  }

  if (msg.kind === "fields") {
    // Verbatim mirror of a patchConversation gesture. patchConversation
    // Object.assigns the same fields onto BOTH twins, so both get them here.
    // A fields message is one causal transition: guard all touched hidden/pin
    // state before writing any subset, so a delayed partial patch cannot leave
    // conflicting bucket timestamps behind.
    const fields = Object.entries(msg.fields);
    const guardFields = [
      ...(fields.some(([key]) => key === "inbox_dismissed_at" || key === "inbox_stashed_at")
        ? ["inbox_dismissed_at", "inbox_stashed_at"]
        : []),
      ...(fields.some(([key]) => key === "is_pinned" || key === "inbox_pinned_at")
        ? ["inbox_pinned_at"]
        : []),
    ];
    acceptTransition(msg.id, guardFields, { shared: Object.fromEntries(fields) });
    return;
  }

  // pin — `pinnedAt` is the sender's exact written value (see gestureBridge.ts:
  // undo restores the ORIGINAL pin time, so it cannot be re-derived from ts).
  // Repeated pin messages leave matching rows untouched; an unpin deliberately
  // plants a null tombstone even when the row already appears unpinned.
  // Touches pin state ONLY: pin is not an un-kill on the sender (pinSession),
  // so a sibling window must not become one either.
  acceptTransition(msg.id, ["inbox_pinned_at"], {
    shared: { inbox_pinned_at: msg.pinnedAt },
    sessions: { is_pinned: msg.pinned },
  });
}

const inboxStoreConfig = (set: any, get: any) => ({
  // -- Initial state --
  // Every registered collection starts as {} by registration alone; explicit
  // slots below only add non-collection state and typed narrowings.
  ...collectionInitialState(),
  sessions: {},
  pending: {},
  dispatchErrors: 0,
  storageDegraded: false,
  lastDispatchFailure: null,
  currentSessionId: null,
  lastFocusedConversationId: null,
  showDismissed: false,
  collapsedSections: {},
  scheduleNavSets: null,
  scheduleStripExpand: null,
  composerPrefill: null,
  recentFreezeOrder: null,
  viewingDismissedId: null,
  pendingNavigateId: null,
  renamingSessionId: null,
  restartingSessions: {},
  movingSessions: {},
  pendingScrollToMessageId: null,
  pendingScrollToMessageTimestamp: null,
  pendingHighlightQuery: null,
  showMySessions: false,
  setShowMySessions: (show: boolean) => set({ showMySessions: show, ...(show ? { showFavorites: false } : {}) }),
  showFavorites: false,
  setShowFavorites: (show: boolean) => set({ showFavorites: show, ...(show ? { showMySessions: false } : {}) }),
  liveInboxIds: new Set<string>(),
  teamInboxIds: new Set<string>(),
  liveInboxIdList: [],
  teamInboxIdSnapshot: null,
  // sync(): the id set is server truth (or its persisted snapshot) — persist to
  // IDB via patches, never dispatch. Both twins move together so the persisted
  // array can never drift from what the UI filtered against.
  setLiveInboxIds: sync(function (this: Draft, ids: string[]) {
    this.liveInboxIds = new Set(ids);
    this.liveInboxIdList = ids;
  }),
  // Team-mode twin of setLiveInboxIds. The snapshot is keyed by team id so a
  // boot into a DIFFERENT active team can never seed another team's stale
  // board (seedTeamInboxIdsFromCache checks the key). sync() for the same
  // reason as above: raw setState would bypass the patch-driven IDB
  // write-through, leaving the snapshot forever stale.
  setTeamInboxIds: sync(function (this: Draft, ids: string[], teamId: string | null) {
    this.teamInboxIds = new Set(ids);
    this.teamInboxIdSnapshot = { team_id: teamId ?? null, ids };
  }),
  // sync(): the cleared flags must persist, or the stale claim resurrects from
  // IDB on the next boot. Only foreign-run rows are touched — my own sessions
  // age out via the old-session partition and keep their fields. A row that
  // reappears in a later payload gets fresh server flags from the delta merge,
  // so clearing here is always recoverable.
  reconcileDisownedSessions: sync(function (this: Draft, ids: string[]) {
    const meId = this.currentUser?._id?.toString?.();
    if (!meId) return;
    const live = new Set(ids);
    for (const [id, s] of Object.entries(this.sessions)) {
      if (live.has(id) || !isConvexId(id)) continue;
      const claimsMe = s.owned_by_me || (s.owner_user_id && s.owner_user_id === meId);
      if (!claimsMe) continue;
      if (!s.user_id || s.user_id === meId) continue;
      s.owned_by_me = false;
      s.owner_user_id = null;
    }
  }),
  setShowOldSessions: (show: boolean) => get().updateClientUI({ inbox_show_old: show }),
  _lastViewedAt: {},
  _seenUpToAt: {},
  _seenMessageCount: {},

  messages: {},
  pendingMessages: {},
  pagination: {},
  conversations: {},
  userMessages: {},
  feedConversations: {},
  feedHasMore: {},
  feedCursors: {},
  syncMeta: {},
  // Seed UI from localStorage so layout-affecting prefs (sidebar collapsed,
  // zen mode, inbox shortcut bar) are correct on first paint. IDB hydration
  // fills in everything else and is the source of truth across tabs.
  clientState: { ui: readCriticalUiPrefs() as ClientUI },
  clientStateInitialized: false,

  drafts: {},
  queuedMessages: {},

  reviewMessageId: null,
  reviewActiveBlock: 0,
  reviewEditingId: null,
  reviewComments: {},

  commentRailAnchor: null,
  commentRailNonce: 0,
  commentRailWidth: {},
  // The comment rail and the session list share the ONE right edge, so opening
  // comments displaces the rail rather than stacking a second one. Closing
  // comments hands the edge back to the session list unless you had closed the
  // rail by hand — the slot's own dismissal answers that, no extra flag.
  setCommentRailOpen: (open: boolean | null) => {
    const st = get();
    const conv = st.currentSessionId ?? st.viewingDismissedId ?? null;
    if (open === true && conv) st.wsShow("context", { kind: "comments", ref: conv });
    else if (wsAutoAllowedPure(st.workspace, "context", SESSION_LIST_PANE)) st.wsShow("context", SESSION_LIST_PANE);
    else st.wsHide("context", { remember: false });
  },
  // Focus/expand a message's inline anchored thread (the gutter handle). Doesn't
  // open the global dock — anchored threads live inline at their message.
  openCommentThread: (messageId: string | null = null) =>
    set((s: any) => ({ commentRailAnchor: messageId, commentRailNonce: s.commentRailNonce + 1 })),
  threadCardOpen: {},
  patchThreadCardOpen: (patch: Record<string, ThreadCardOpenEntry>) =>
    set((s: any) => ({ threadCardOpen: { ...s.threadCardOpen, ...patch } })),
  closeCommentRail: () => get().setCommentRailOpen(false),
  setCommentRailWidth: (conversationId: string, w: number) =>
    set((s: any) => {
      if ((s.commentRailWidth[conversationId] ?? 0) === w) return {};
      const next = { ...s.commentRailWidth };
      if (w) next[conversationId] = w;
      else delete next[conversationId];
      return { commentRailWidth: next };
    }),

  setReviewTarget: (messageId: string | null, blockIndex = 0) =>
    set({ reviewMessageId: messageId, reviewActiveBlock: messageId ? blockIndex : 0 }),
  setReviewActiveBlock: (blockIndex: number) => set({ reviewActiveBlock: blockIndex }),
  setReviewEditingId: (id: string | null) => set({ reviewEditingId: id }),
  addReviewComment: (conversationId: string, comment: PendingComment) =>
    set((s: any) => ({
      reviewComments: {
        ...s.reviewComments,
        [conversationId]: [...(s.reviewComments[conversationId] ?? []), comment],
      },
    })),
  // Set a comment's note (may be empty → stays a bare quote). This is what the
  // note editor's "Save" does.
  commitReviewComment: (conversationId: string, id: string, body: string) =>
    set((s: any) => ({
      reviewComments: {
        ...s.reviewComments,
        [conversationId]: (s.reviewComments[conversationId] ?? []).map((c: PendingComment) =>
          c.id === id ? { ...c, body } : c,
        ),
      },
    })),
  removeReviewComment: (conversationId: string, id: string) =>
    set((s: any) => {
      const list: PendingComment[] = s.reviewComments[conversationId] ?? [];
      const removed = list.find((c) => c.id === id);
      const next = list.filter((c: PendingComment) => c.id !== id);
      const map = { ...s.reviewComments };
      if (next.length) map[conversationId] = next;
      else delete map[conversationId];
      const patch: any = { reviewComments: map };
      // If the removed comment's editor was open, close it.
      if (s.reviewEditingId === id) patch.reviewEditingId = null;
      // When the review-target message has no quotes left, drop the target so its
      // active-block highlight overlay stops painting (handles both the last quote
      // overall and the last quote on the target message of a multi-message batch).
      const targetMsg = s.reviewMessageId;
      if (targetMsg && removed?.messageId === targetMsg && !next.some((c) => c.messageId === targetMsg)) {
        patch.reviewMessageId = null;
        patch.reviewActiveBlock = 0;
        patch.reviewEditingId = null;
      }
      return patch;
    }),
  clearReviewComments: (conversationId: string) =>
    set((s: any) => {
      if (!s.reviewComments[conversationId]) return {};
      const map = { ...s.reviewComments };
      delete map[conversationId];
      return { reviewComments: map };
    }),
  getReviewComments: (conversationId: string) => get().reviewComments[conversationId] ?? [],

  pendingSessionCreates: {},

  currentConversation: {},
  isolatedWorktreeMode: false,

  palette: { open: false, targets: [], targetType: null, initialMode: 'root' },

  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan' | 'session'; mode?: string; initialQuery?: string; pick?: PalettePick }) => {
    set({
      palette: {
        open: true,
        targets: opts?.targets || [],
        targetType: opts?.targetType || null,
        initialMode: opts?.mode || 'root',
        initialQuery: opts?.initialQuery,
        pick: opts?.pick,
      },
    });
  },

  closePalette: () => {
    set({ palette: { open: false, targets: [], targetType: null, initialMode: 'root' } });
  },

  togglePalette: () => {
    const { palette } = get();
    if (palette.open) {
      set({ palette: { open: false, targets: [], targetType: null, initialMode: 'root' } });
    } else {
      set({ palette: { open: true, targets: [], targetType: null, initialMode: 'root' } });
    }
  },

  compose: { open: false, nonce: 0 },
  openCompose: (initialQuery?: string, context?: { projectPath?: string; gitRoot?: string }) => {
    set({ compose: { open: true, initialQuery, context, nonce: get().compose.nonce + 1 } });
  },
  closeCompose: () => {
    set({ compose: { ...get().compose, open: false } });
  },

  createModal: null,
  createModalDefaults: null,
  openCreateModal: (type: CreateModalKind, defaults?: { project_id?: string; plan_id?: string }) =>
    set({ createModal: type, createModalDefaults: defaults ?? null }),
  closeCreateModal: () => set({ createModal: null, createModalDefaults: null }),

  taskCloseGuard: null,
  setTaskCloseGuard: (g: { shortId: string; status: 'done' | 'dropped'; open: TaskItem[]; statusId?: string } | null) => set({ taskCloseGuard: g }),

  optimisticForkChildren: [],
  recentProjects: [],
  setRecentProjects: action(function (this: Draft, projects: Array<{ path: string; count: number; lastActive: number }>) {
    this.recentProjects = projects;
  }),
  recentProjectsByDevice: {},
  setRecentProjectsForDevice: sync(function (this: Draft, deviceId: string, projects: Array<{ path: string; count: number; lastActive: number; suggested?: boolean }>) {
    this.recentProjectsByDevice[deviceId] = projects;
  }),
  machineRoster: [],
  machineRosterLive: false,
  setMachineRoster: sync(function (this: Draft, devices: MachineCandidate[]) {
    this.machineRoster = devices;
    this.machineRosterLive = true;
  }),
  sessionThreads: null,
  sessionMetricsAggregate: null,

  // Trigger verbs mirror the server's applyPause/Resume/RunNow/Cancel/
  // Reactivate on the draft; the same-named dispatch side effects run them.
  // Deleting a row in a localFirst collection auto-plants an exclude
  // tombstone (mutativeMiddleware), so the next webList snapshot can't
  // resurrect it before the mutation commits.
  triggerAction: action(function (
    this: Draft,
    taskId: string,
    verb: "pause" | "resume" | "runNow" | "cancel" | "reactivate",
  ) {
    const t = (this.agentTasks as any)[taskId];
    if (!t) return;
    const now = Date.now();
    switch (verb) {
      case "pause": t.status = "paused"; break;
      case "resume": t.status = "scheduled"; break;
      case "runNow": t.status = "scheduled"; t.run_at = now; break;
      case "cancel": t.status = "completed"; break;
      case "reactivate":
        t.status = "scheduled";
        t.run_at = now + (t.schedule_type === "recurring" && t.interval_ms ? t.interval_ms : 60_000);
        break;
    }
  }),
  deleteTrigger: action(function (this: Draft, taskId: string) {
    delete (this.agentTasks as any)[taskId];
  }),
  dropRows: sync(function (this: Draft, key: string, ids: string[]) {
    const coll = (this as any)[key];
    if (!coll) return;
    for (const id of ids) if (id in coll) delete coll[id];
  }),
  activeProjectPath: null,
  activeProjectFilter: null,
  chipFilterExclude: false,
  setActiveProjectFilter: action(function (this: Draft, name: string | null, path?: string | null, exclude?: boolean) {
    const prev = snapshotInboxViewFromDraft(this);
    this.activeProjectFilter = name;
    this.activeProjectPath = path ?? null;
    // The exclude flag belongs to whichever chip is active. Clearing THIS axis
    // only resets it when the other axis isn't holding a filter — otherwise a
    // stray setActiveProjectFilter(null) would flip a bucket EXCLUSION into a
    // bucket include ("hide L" → "only L") without a click.
    this.chipFilterExclude = name ? !!exclude : this.activeBucketFilter ? this.chipFilterExclude : false;
    // The chip row is ONE filter: picking a project clears any bucket focus.
    if (name) {
      this.activeBucketFilter = null;
      // An exclusion isn't a "view" you revisit — only include mode records.
      if (!exclude) recordVisitInDraft(this, { kind: "view", key: `project:${name}`, label: name, path: path ?? undefined });
    }
    commitChipFilterChange(this, prev);
  }),

  // -- Capability library --
  capabilityState: {},
  capabilityBindings: {},
  setCapabilityBinding: action(function (this: Draft, opts: {
    capability_slug: string;
    scope_kind: string;
    scope_key?: string;
    enabled: boolean;
    team_id?: string;
    client_key?: string;
  }) {
    const scopeKey = opts.scope_key ?? "";
    // The upsert key mirrors the server's (user, slug, scope_kind, scope_key):
    // an existing row flips in place, else a stub keyed by client_key lands
    // and the server row supersedes it on sync (altKey convention).
    const existing = Object.values(this.capabilityBindings).find(
      (b) =>
        b.capability_slug === opts.capability_slug &&
        b.scope_kind === opts.scope_kind &&
        (b.scope_key ?? "") === scopeKey,
    );
    if (existing) {
      existing.enabled = opts.enabled;
      existing.updated_at = Date.now();
      return;
    }
    const clientKey = opts.client_key ?? `cb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.capabilityBindings[clientKey] = {
      _id: clientKey,
      capability_slug: opts.capability_slug,
      scope_kind: opts.scope_kind,
      scope_key: scopeKey,
      enabled: opts.enabled,
      team_id: opts.team_id,
      client_key: clientKey,
      created_by: "user",
      updated_at: Date.now(),
    };
  }),

  // -- Decision queue (cast decide) --
  sessionDecisions: {},
  questionResolutions: {},
  // sync(): local-only bookkeeping — the mark never dispatches; server truth
  // arrives on its own rail (awaiting_input / agent_status) and expires it.
  resolveSessionQuestion: sync(function (this: Draft, convId: string, opts?: { sends?: number }) {
    const row = this.sessions[convId];
    this.questionResolutions[convId] = {
      at: Date.now(),
      message_count: (row?.message_count ?? 0) + (opts?.sends ?? 0),
    };
  }),
  answerDecision: action(function (this: Draft, decisionId: string, answer: { index?: number; text?: string } | { dismiss: true }) {
    const row = this.sessionDecisions[decisionId];
    if (!row || row.status !== "pending") return;
    const now = Date.now();
    if ("dismiss" in answer) {
      row.status = "dismissed";
      row.resolved_at = now;
      return;
    }
    row.status = "answered";
    row.answer_index = answer.index;
    row.answer_text = answer.text;
    row.resolved_at = now;
    // The chosen option enters the session as a normal user message so the
    // parked agent resumes with it — same rail as typing into the composer,
    // reusing the standard optimistic-bubble + outbox send pair (the mobile
    // AUQ answer path does the identical two-step). Deferred to after this
    // draft commits because both are themselves decorated store functions.
    const label = answer.index !== undefined ? row.options[answer.index]?.label : undefined;
    const content = answer.text ?? (label ? `Decision: ${label}` : undefined);
    const convId = row.conversation_id;
    if (content) {
      queueMicrotask(() => {
        const s = useInboxStore.getState();
        const clientId = s.addOptimisticMessage(convId, content);
        s.sendMessage(convId, content, undefined, clientId);
      });
    }
  }),

  // -- Manual session buckets --
  buckets: {},
  bucketAssignments: {},
  activeBucketFilter: null,
  setActiveBucketFilter: action(function (this: Draft, bucketId: string | null, exclude?: boolean) {
    const prev = snapshotInboxViewFromDraft(this);
    this.activeBucketFilter = bucketId;
    // Mirror of setActiveProjectFilter: don't clobber a project exclusion.
    this.chipFilterExclude = bucketId ? !!exclude : this.activeProjectFilter ? this.chipFilterExclude : false;
    if (bucketId) {
      this.activeProjectFilter = null;
      this.activeProjectPath = null;
      if (!exclude) recordVisitInDraft(this, { kind: "view", key: `label:${bucketId}`, label: (this.buckets as any)[bucketId]?.name });
    }
    commitChipFilterChange(this, prev);
  }),
  inboxViewMode: () => resolveInboxViewMode(get().clientState.ui),
  setInboxViewMode: (mode: InboxViewMode) => {
    const state = get();
    const prev = snapshotInboxViewFromDraft(state);
    // inbox_flat_view stays coherent so existing flat-view readers keep working:
    // both flat modes ("recent"/"time") flatten for an older reader.
    state.updateClientUI({ inbox_view_mode: mode, inbox_flat_view: mode === "time" || mode === "recent" });
    // A frozen recent order is meaningless once you leave recent — drop it so a
    // later return to recent starts live.
    if (mode !== "recent") state.thawRecentOrder();
    pushInboxViewHistory(prev, snapshotInboxViewFromDraft(get()));
  },
  cycleInboxViewMode: () => {
    const state = get();
    const current = state.inboxViewMode();
    const hasBuckets = (Object.values(state.buckets) as BucketItem[]).some((b) => !b.archived_at);
    const hasPlans = (Object.values(state.sessions) as InboxSession[]).some((s) => !!s.active_plan);
    // Trigger data lives in the panel's Convex subscription; its published nav
    // bridge is the store's only sight of whether any triggers exist.
    const hasTriggers = (state.scheduleNavSets?.triggerOrder?.length ?? 0) > 0;
    const cycle: Array<InboxViewMode> = [
      "grouped", "recent", "time",
      ...(hasBuckets ? ["bucket" as const] : []),
      ...(hasPlans ? ["plan" as const] : []),
      ...(hasTriggers ? ["trigger" as const] : []),
    ];
    state.setInboxViewMode(cycle[(cycle.indexOf(current) + 1) % cycle.length]);
  },
  setSessionManualOrder: (id: string, key: number) => {
    const current = get().clientState.ui?.inbox_manual_order ?? {};
    get().updateClientUI({ inbox_manual_order: { ...current, [id]: key } });
  },
  clearManualOrder: () => {
    if (!get().clientState.ui?.inbox_manual_order) return;
    get().updateClientUI({ inbox_manual_order: {} });
  },

  recentVisits: [],
  recordRecentVisit: sync(function (this: Draft, visit: Omit<RecentVisit, "ts">) {
    recordVisitInDraft(this, visit);
  }),

  // Same cursors recordSessionView writes when LEAVING a session, written
  // here on demand: expanding a session card on the Threads page is reading
  // it, so its unread badge (message_count > _seenMessageCount) clears.
  markSessionSeen: sync(function (this: Draft, id: string) {
    if (!id) return;
    const count = this.conversations[id]?.message_count ?? this.sessions[id]?.message_count;
    if (typeof count === "number") this._seenMessageCount[id] = count;
    this._seenUpToAt[id] = Date.now();
  }),

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  // Stash = set aside WITHOUT killing (Stashed bucket, agent keeps running).
  stashSession: action(function (this: Draft, id: string) {
    soundDismiss();
    announceHide(this, "stash", hideSessionInDraft(this, id, "stash"));
  }),

  // Kill = done with it. The server tears the agent down on the hide data
  // transition (dispatch.applyPatches sees inbox_dismissed_at flip), so this
  // action only has to move the rows; every kill path gets the teardown
  // without remembering to ask for it. (The persisted field keeps its
  // historical name inbox_dismissed_at and the UI calls the bucket "Killed";
  // the server's kill transition additionally stamps inbox_killed_at, which is
  // what actually marks the row retired.)
  killSession: action(function (this: Draft, id: string) {
    soundKill();
    announceHide(this, "kill", hideSessionInDraft(this, id, "kill"));
  }),

  // Bulk kill ("Kill all" on the Stashed bucket): one action so the patches
  // ride a single dispatch and the kill sound plays once, not N times. Scale
  // is the user-curated stash list (tens) — each row NEEDS its own server
  // patch anyway (the per-conversation hide transition is what enqueues the
  // agent teardown), so the markSessionsDismissed storm concern doesn't apply.
  killSessions: action(function (this: Draft, ids: string[]) {
    if (ids.length === 0) return;
    soundKill();
    // "Kill all" is ONE user gesture: one timestamp for every row it stamps and
    // for the single merged broadcast (the sound plays once for the same reason).
    // Per-row Date.now() drifts across a long sweep, so the message's timestamp
    // matched only the last row — every sibling lock planted for an earlier row
    // held a value the server would never echo, and so would never retire.
    const now = Date.now();
    const merged = { hidden: [] as string[], forgotten: [] as string[], ts: now };
    for (const id of ids) {
      const r = hideSessionInDraft(this, id, "kill", now);
      merged.hidden.push(...r.hidden);
      merged.forgotten.push(...r.forgotten);
    }
    announceHide(this, "kill", merged);
  }),

  // Bulk-dismiss a precomputed set of sessions locally (instant, optimistic). A
  // sync() — NOT action() — on purpose: action() auto-dispatches one server patch
  // per mutated conversation, so dismissing thousands would be a dispatch storm.
  // The caller persists authoritatively with ONE paginated server mutation
  // (conversations.dismissStaleInboxSessions) instead. Skips already-dismissed
  // rows. Used by the "dismiss old sessions" inbox prompt.
  markSessionsDismissed: sync(function (this: Draft, ids: string[]) {
    const now = Date.now();
    const stamped: string[] = [];
    for (const id of ids) {
      const sess = this.sessions[id];
      if (sess && !sess.inbox_dismissed_at) {
        sess.inbox_dismissed_at = now;
        stamped.push(id);
      }
      if (this.conversations[id] && !(this.conversations[id] as any).inbox_dismissed_at) {
        (this.conversations[id] as any).inbox_dismissed_at = now;
      }
    }
    // The bulk sweep is the highest-volume dismissal path there is, and every
    // row it stamps is one a sibling window would otherwise re-put un-dismissed
    // — dozens of sessions climbing back into the inbox at once. One message
    // for the whole sweep, carrying only the ids actually stamped.
    //
    // mode:"kill" is the shape (it writes inbox_dismissed_at). The receiver's
    // kill also clears stash/pin, which this action doesn't — a no-op in
    // practice, since the caller's stale set already excludes hidden and pinned
    // rows, and the receiver's ts guard protects a sibling's newer pin anyway.
    if (stamped.length) {
      broadcastGesture({ kind: "hide", mode: "kill", ids: stamped, ts: now }, bridgeUserId(this));
    }
  }),

  // Optimistic clear of the API-error banner flag — the blocked-sessions
  // banner's per-row "never restart this" decision. Same shape as
  // markSessionsDismissed: local sync() for the instant UI, the caller
  // persists with ONE server mutation (accountSwitch.acknowledgeBlocked).
  markBlockedAcknowledged: sync(function (this: Draft, ids: string[]) {
    for (const id of ids) {
      const sess = this.sessions[id];
      if (sess) {
        sess.pending_api_error = false;
        sess.pending_api_error_kind = null;
        sess.pending_api_error_at = null;
      }
      const conv = this.conversations[id] as any;
      if (conv) {
        conv.pending_api_error = false;
        conv.pending_api_error_kind = null;
        conv.pending_api_error_at = null;
      }
    }
  }),

  // Optimistic "revive is in flight" stamp for the blocked-sessions banner's
  // continue/switch actions. pending_api_error is server-derived (it clears
  // only when the agent resumes and its new output syncs), so a direct clear
  // here would be stomped by the next session sync. Instead the stamp is a
  // separate local map that classification (categorizeSessions) and the
  // banner/pill exclusion read through freshReviveRequestIds — the sessions
  // move to WORKING instantly, and if the revive never lands the stamp ages
  // out (BLOCKED_REVIVE_TTL_MS) and the blocked state honestly resurfaces.
  markBlockedReviveRequested: sync(function (this: Draft, ids: string[]) {
    const now = Date.now();
    // Prune expired stamps on write so the map never accumulates.
    for (const [id, at] of Object.entries(this.blockedReviveRequestedAt)) {
      if (now - at > BLOCKED_REVIVE_TTL_MS) delete this.blockedReviveRequestedAt[id];
    }
    for (const id of ids) this.blockedReviveRequestedAt[id] = now;
  }),

  // Honest revert when the revive mutation fails outright.
  clearBlockedReviveRequested: sync(function (this: Draft, ids: string[]) {
    for (const id of ids) delete this.blockedReviveRequestedAt[id];
  }),

  // Durable cross-device dismiss reconcile (the backstop the live subscription
  // can't provide). `entries` is the server's CURRENT dismissed set within the
  // window (conversations.listDismissedSessionsLite). A sync() — applying
  // server truth, never re-dispatched. Mechanics in applyHiddenReconcileInDraft.
  applyDismissedReconcile: sync(function (this: Draft, entries: { _id: string; inbox_dismissed_at: number | null }[], final: boolean) {
    applyHiddenReconcileInDraft(this, "inbox_dismissed_at", entries, final);
  }),

  // Stashed twin of the dismiss reconcile, fed by listStashedSessionsLite.
  applyStashedReconcile: sync(function (this: Draft, entries: { _id: string; inbox_stashed_at: number | null }[], final: boolean) {
    applyHiddenReconcileInDraft(this, "inbox_stashed_at", entries, final);
  }),

  // Verified ghost removal — the sessions cache is never-prune, so a
  // conversation hard-deleted server-side (cleanup.gcEmptyConversations) leaves
  // a permanent "New Session" ghost card. Callers verify Convex ids against the
  // server (conversations.existingConversationIds) BEFORE calling: the planted
  // excludes are sticky in delta mode, so a wrong delete would blind this
  // client to a live session. Stub ids (orphaned optimistic creates that never
  // landed server-side) are passed unverified — the server can't vouch for ids
  // it never had; the caller's age/idleness guards are the safety there. The
  // excludes are what authorize the IDB row delete (a bare store-shrink is
  // ignored by the diff). A sync() — never re-dispatched; excludes are planted
  // manually (only action() auto-plants).
  pruneGhostSessions: sync(function (this: Draft, ids: string[]) {
    const now = Date.now();
    const removed: string[] = [];
    for (const id of ids) {
      // Nothing here to remove → do nothing at all. Callers re-fire on ids they
      // already pruned (ConversationView's 3s retry, ComposeView's unmount), and
      // acting on an absent row is pure downside: the excludes are STICKY, so
      // planting them for a row this window never held blinds it if that id ever
      // arrives on a later crawl, and the broadcast would order sibling windows
      // to drop a row on evidence this window doesn't have.
      if (!(id in this.sessions) && !(id in this.conversations)) continue;
      if (this.currentSessionId === id) continue;
      if (this.pendingMessages[id]?.length) continue;
      if (id in this.pendingSessionCreates) continue;
      removed.push(id);
      delete this.sessions[id];
      delete this.conversations[id];
      delete this.messages[id];
      delete this.pendingMessages[id];
      delete this.pagination[id];
      this.pending[`sessions:${id}`] = { type: "exclude", ts: now };
      this.pending[`conversations:${id}`] = { type: "exclude", ts: now };
    }
    // A sibling window still holding the ghost in memory would re-put the whole
    // row and resurrect it (see gestureBridge.ts). Only the ids actually removed
    // are announced — the guards above are per-window.
    if (removed.length) broadcastGesture({ kind: "forget", ids: removed, ts: now }, bridgeUserId(this));
  }),

  // Apply a gesture a sibling window performed (cross-window gesture bridge).
  // sync(): purely local convergence — the acting window already dispatched the
  // single server write, so this must never dispatch or enqueue an outbox entry.
  // Mechanics and guards in applyGestureInDraft.
  applyGestureBridge: sync(function (this: Draft, msg: GestureMessage) {
    applyGestureInDraft(this, msg);
  }),

  // Change-feed prune: the entity is gone or no longer visible to this user, so
  // remove it from the never-prune cache and plant an exclude (the exclude is
  // what authorizes the durable IDB delete; a bare store-shrink is ignored by the
  // diff and would resurrect on reload). Mirrors pruneGhostSessions' session
  // guards, generalized to the four feed collections. sync() — applying a
  // server-side deletion the feed reported; never re-dispatched. The matching
  // clearFeedExcludes lifts the exclude if the entity ever reappears. See
  // hooks/useSyncChangeFeed.
  pruneFeedEntities: sync(function (this: Draft, collection: FeedCollection, ids: string[]) {
    const now = Date.now();
    for (const id of ids) {
      if (collection === "sessions") {
        if (this.currentSessionId === id) continue;
        if (this.pendingMessages[id]?.length) continue;
        if (id in this.pendingSessionCreates) continue;
        delete this.sessions[id];
        delete this.conversations[id];
        delete this.messages[id];
        delete this.pendingMessages[id];
        delete this.pagination[id];
        this.pending[`sessions:${id}`] = { type: "exclude", ts: now };
        this.pending[`conversations:${id}`] = { type: "exclude", ts: now };
      } else {
        const coll = (this as any)[collection] as Record<string, any> | undefined;
        if (coll && id in coll) delete coll[id];
        this.pending[`${collection}:${id}`] = { type: "exclude", ts: now };
      }
    }
  }),

  // Lift any feed-planted exclude for ids the feed is about to re-upsert. Delta
  // sync SKIPS excluded ids, so without this a re-shared / restored entity that
  // reappears in a batch-get would be silently dropped forever. Called just
  // before the feed's syncTable upsert. sync() — local pending bookkeeping only.
  clearFeedExcludes: sync(function (this: Draft, collection: FeedCollection, ids: string[]) {
    for (const id of ids) {
      if (this.pending[`${collection}:${id}`]?.type === "exclude") delete this.pending[`${collection}:${id}`];
      if (collection === "sessions" && this.pending[`conversations:${id}`]?.type === "exclude") {
        delete this.pending[`conversations:${id}`];
      }
    }
  }),

  // Flag a cached conversation whose server row turned out to be deleted (a
  // dispatch hit "conversation_deleted"). The never-prune cache keeps rendering
  // it; this flag lets the view say so and offer restore instead of silently
  // failing. sync() — local bookkeeping only; no server row exists to patch,
  // and since the server never syncs this conversation again the flag sticks.
  markServerDeleted: sync(function (this: Draft, convId: string) {
    const sess = this.sessions[convId] as any;
    if (sess) sess.server_deleted = true;
    const conv = this.conversations[convId] as any;
    if (conv) conv.server_deleted = true;
  }),

  // ── Sync-log write acks (design D8) ─────────────────────────────────────────
  // Stamp the sync-log positions a dispatch landed at onto the pending entries
  // that dispatch created. Keys derive from the dispatched (table-grouped)
  // patches through the registry's table→storeKey mapping — the same rows the
  // engine's auto-pending derived its entries from. Guard: only entries whose
  // `ts` predates the dispatch send get the ack; a newer local write replaced
  // the entry object (auto-pending makes fresh objects), so an older write's
  // ack can never retire it. If the scope cursor already passed the position,
  // retire immediately (the ack raced the applier). sync() — local bookkeeping.
  stampSyncAck: sync(function (
    this: Draft,
    patches: any,
    ack: Array<{ scope_key: string; position: number }>,
    sentAt: number,
  ) {
    if (!patches || typeof patches !== "object" || !Array.isArray(ack) || ack.length === 0) return;
    const compact = ack.map((a) => ({ s: a.scope_key, p: a.position }));
    for (const [table, byId] of Object.entries(patches)) {
      const storeKeys = TABLE_TO_STORE_KEYS[table];
      if (!storeKeys || !byId || typeof byId !== "object") continue;
      for (const [docId, fields] of Object.entries(byId as Record<string, any>)) {
        if (docId === "_" || !fields || typeof fields !== "object") continue;
        for (const storeKey of storeKeys) {
          for (const [field, sentValue] of Object.entries(fields as Record<string, any>)) {
            const key = `${storeKey}:${docId}:${field}`;
            const entry = this.pending[key] as any;
            if (!entry) continue;
            // Guard by VALUE, not send-time ordering: an outbox redrive or
            // retry invokes the binding long after the write was drafted, so a
            // time guard lets an old write's ack stamp (and retire) the entry
            // protecting a NEWER local write. The entry corresponds to THIS
            // dispatch iff it still protects the dispatched value; if a newer
            // write changed it, values differ and we skip — value-echo
            // retirement owns that entry. Objects compare by JSON because both
            // sides may have crossed an IDB structured-clone boundary.
            const v = entry.value;
            const same = v === sentValue ||
              (v !== null && sentValue !== null &&
               typeof v === "object" && typeof sentValue === "object" &&
               JSON.stringify(v) === JSON.stringify(sentValue));
            if (!same || (entry.ts ?? 0) > sentAt) continue;
            if (compact.some((a) => (this.syncMeta[syncLogScopeMetaKey(a.s)]?.cursor ?? 0) >= a.p)) {
              delete this.pending[key];
            } else {
              entry.ack = compact;
            }
          }
        }
      }
    }
  }),

  // Retire every pending entry whose ack says its write landed at or below the
  // position this scope has now applied through. Called by the log applier
  // BEFORE it overlays the range's stage-two rows, so the authoritative
  // post-write state lands unblocked (review: retiring after the apply strands
  // a diverged field with no lock and no re-fetch). sync() — local bookkeeping.
  retireAckedPending: sync(function (this: Draft, scopeKey: string, upTo: number) {
    for (const [key, entry] of Object.entries(this.pending)) {
      const ackList = (entry as any)?.ack as Array<{ s: string; p: number }> | undefined;
      if (ackList?.some((a) => a.s === scopeKey && a.p <= upTo)) {
        delete this.pending[key];
      }
    }
  }),

  // Scope revocation (design D5): the log said this user left a team. Purge the
  // workspace-scoped collections' rows for that team (access is gone; keeping
  // them renders data the server would no longer serve) and plant excludes so
  // the durable IDB rows delete too. Conversations are owner-scoped and
  // untouched. The caller drops the scope's log cursor separately.
  purgeTeamScopeRows: sync(function (this: Draft, teamId: string) {
    const wsKey = `team:${teamId}`;
    const now = Date.now();
    for (const coll of ["tasks", "docs", "plans", "projects"] as const) {
      const rows = (this as any)[coll] as Record<string, any> | undefined;
      if (!rows) continue;
      for (const [id, row] of Object.entries(rows)) {
        if (row?.workspace === wsKey) {
          delete rows[id];
          this.pending[`${coll}:${id}`] = { type: "exclude", ts: now };
        }
      }
    }
  }),

  // Drop a syncMeta key outright (recordSyncMeta only advances). Used for log
  // cursor resets: scope revocation and retention resync.
  clearSyncMeta: sync(function (this: Draft, key: string) {
    delete this.syncMeta[key];
  }),

  // Clear every tasks/docs crawl watermark belonging to one sync-log scope, so
  // the next crawl runs as a FULL backfill (design D7 resync / D5 scope_added).
  // Crawl keys are `${ns}:v2:${JSON.stringify(wsArgs)}` — several per scope
  // (project_path variants) and never byte-reconstructable from a scope key
  // (object key order), so this parses and matches instead of concatenating.
  clearCrawlMetaForScope: sync(function (this: Draft, scopeKey: string) {
    const teamId = scopeKey.startsWith("team:") ? scopeKey.slice(5) : null;
    const personal = scopeKey.startsWith("user:");
    for (const key of Object.keys(this.syncMeta)) {
      const m = /^(tasks|docs):v2:(.*)$/.exec(key);
      if (!m) continue;
      try {
        const ws = JSON.parse(m[2]);
        const matches = teamId
          ? ws?.workspace === "team" && String(ws.team_id) === teamId
          : personal && ws?.workspace === "personal";
        if (matches) delete this.syncMeta[key];
      } catch {
        // not a JSON wsKey (e.g. "skip") — nothing to clear
      }
    }
  }),

  switchAgent: action(function (this: Draft, currentId: string, targetAgentType: string) {
    const session = this.sessions[currentId];
    if (!session) return null;

    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    const agentLabels: Record<string, string> = { claude_code: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini" };

    if (this.sessions[currentId]) {
      this.sessions[currentId].inbox_dismissed_at = now;
      if (this.sessions[currentId].is_pinned) {
        this.sessions[currentId].is_pinned = false;
        this.sessions[currentId].inbox_pinned_at = null;
      }
    }
    if (this.conversations[currentId]) {
      (this.conversations[currentId] as any).inbox_dismissed_at = now;
    }

    this.sessions[sessionId] = {
      _id: sessionId,
      session_id: sessionId,
      title: session.title ? `${agentLabels[targetAgentType] || targetAgentType}: ${session.title}` : "New session",
      updated_at: now,
      started_at: now,
      project_path: session.project_path,
      git_root: session.git_root,
      agent_type: targetAgentType,
      message_count: 0,
      is_idle: true,
      has_pending: false,
      last_user_message: null,
    } as InboxSession;

    declareViewNav("gesture");
    this.currentSessionId = sessionId;
    this.viewingDismissedId = null;
    recordCurrentConversationPointer(this, sessionId);

    const draft = this.drafts[currentId]
      ?? (this.clientState.drafts?.[currentId] && typeof this.clientState.drafts[currentId] === "object"
        ? this.clientState.drafts[currentId] as Record<string, any>
        : undefined);
    if (draft) {
      this.drafts[sessionId] = draft;
      delete this.drafts[currentId];
      if (!this.clientState.drafts) this.clientState.drafts = {};
      this.clientState.drafts[sessionId] = draft;
      this.clientState.drafts[currentId] = null;
    }

    return sessionId;
  }),


  // Bring a stashed/dismissed session (and its hidden children) back into the
  // active inbox. Clears ALL THREE hide flags — un-hiding is un-hiding.
  //
  // inbox_killed_at has to go with them. Restore is one of the three sanctioned
  // revivals (with an explicit send and Restart), and it is the only one that
  // reaches a row killed through the killSession MUTATION (the web's
  // convCommand("killSession") — the /sessions kill button and the panel's
  // kill-and-complete), which stamps the marker WITHOUT inbox_dismissed_at.
  // (`cast kill` and the web's own kill action both write inbox_dismissed_at
  // too, so those rows were already covered.) The server's un-kill mirror can't
  // cover a marker-only row for us: it fires only when the patch clears
  // inbox_dismissed_at on a row that already had it (dispatch.ts
  // `wasDismissed`), so it would keep being hidden by shouldShowInInbox no
  // matter how often the user pressed restore. Clearing all three is also
  // exactly the un-kill SHAPE the dispatch guard demands before it will honor a
  // kill-clear at all, and what `cast undismiss` writes.
  restoreSession: action(function (this: Draft, id: string) {
    const now = Date.now();
    const childIds = Object.values(this.sessions as Record<string, InboxSession>)
      .filter((s) => isSessionHidden(s) && s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    for (const sid of allIds) {
      if (this.sessions[sid]) {
        this.sessions[sid].inbox_dismissed_at = null;
        this.sessions[sid].inbox_stashed_at = null;
        this.sessions[sid].inbox_killed_at = null;
      }
      const conv = this.conversations[sid] as any;
      if (conv) {
        conv.inbox_dismissed_at = null;
        conv.inbox_stashed_at = null;
        conv.inbox_killed_at = null;
      }
    }
    declareViewNav("gesture");
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    recordCurrentConversationPointer(this, id);
    // Sibling windows converge on the same clear (gestureBridge.ts) — but only
    // the flags: the view move above is this window's alone.
    broadcastGesture({ kind: "restore", ids: allIds, ts: now }, bridgeUserId(this));
  }),

  deferSession: action(function (this: Draft, id: string) {
    const now = Date.now();
    if (this.sessions[id]) {
      this.sessions[id].is_deferred = true;
      // The server field, on the session row: the sessions→conversations
      // field-whitelist dispatch carries it even when the conversations meta
      // row doesn't exist yet (session never opened on this client).
      (this.sessions[id] as any).inbox_deferred_at = now;
    }
    if (this.conversations[id]) (this.conversations[id] as any).inbox_deferred_at = now;
  }),

  // "A machine owns this — wake me when something happens." Same shape as
  // deferSession: a stamp on the row that any later activity expires (the
  // server honors it only while >= updated_at, so a wake un-parks it with no
  // clearing write). The row moves from Needs Input to Dormant locally at once.
  dormantSession: action(function (this: Draft, id: string) {
    const now = Date.now();
    if (this.sessions[id]) {
      this.sessions[id].is_dormant = true;
      this.sessions[id].inbox_dormant_at = now;
    }
    if (this.conversations[id]) (this.conversations[id] as any).inbox_dormant_at = now;
  }),

  pinSession: action(function (this: Draft, id: string) {
    const newPinned = !this.sessions[id]?.is_pinned;
    const now = Date.now();
    const pinnedAt = newPinned ? now : null;
    if (this.sessions[id]) {
      this.sessions[id].is_pinned = newPinned;
      this.sessions[id].inbox_pinned_at = pinnedAt;
    }
    // Pin is a pure ORDERING gesture, never a revival: it leaves
    // inbox_killed_at (as it already leaves inbox_dismissed_at/inbox_stashed_at)
    // exactly where it is. The sanctioned revivals are an explicit send,
    // Restart, and undismiss — and the server's dispatch rail now DROPS a
    // kill-clear that isn't itself an un-kill, so clearing it optimistically
    // only bought a flicker of a retired row rendering alive until the
    // round-trip put it back. A killed row stays reachable while pinned:
    // shouldShowInInbox keeps `inbox_killed_at && inbox_pinned_at` in the inbox
    // precisely so pinning is how you hold onto one.
    if (this.conversations[id]) {
      (this.conversations[id] as any).inbox_pinned_at = pinnedAt;
    }
    // Pin is a TOGGLE read off this window's row, so a sibling that never saw
    // the flip computes the opposite value from its stale row on the next
    // toggle (and its whole-row put un-pins what the user just pinned). The
    // broadcast therefore carries the RESOLVED value, not "toggle".
    broadcastGesture({ kind: "pin", id, pinned: newPinned, pinnedAt, ts: now }, bridgeUserId(this));
  }),

  renameSession: action(function (this: Draft, id: string, title: string) {
    if (this.sessions[id]) this.sessions[id].title = title;
    if (this.conversations[id]) {
      this.conversations[id].title = title;
      this.conversations[id].title_is_custom = true;
    }
  }),

  switchProject: action(function (this: Draft, convId: string, path: string) {
    if (this.sessions[convId]) {
      this.sessions[convId].project_path = path;
      this.sessions[convId].git_root = path;
    }
    if (!this.conversations[convId]) {
      this.conversations[convId] = { _id: convId } as any;
    }
    this.conversations[convId].project_path = path;
    this.conversations[convId].git_root = path;
  }),

  // Generic local-first conversation patch. `conversations` is wired into the
  // server's applyPatches (every non-immutable field round-trips), so writing
  // here updates the UI instantly AND persists to Convex with no dedicated
  // side-effect — exactly how renameSession works. Mirrors onto sessions[] so
  // inbox and conversation views both reflect the change immediately. Fields in
  // the server's immutable set (is_private/team_visibility/status/agent_type)
  // are silently ignored server-side — use setPrivacy/setTeamVisibility/etc.
  patchConversation: action(function (this: Draft, id: string, fields: Record<string, any>) {
    if (this.sessions[id]) Object.assign(this.sessions[id], fields);
    if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
    Object.assign(this.conversations[id], fields);
    // Both of this action's real callers are USER GESTURES on the /sessions
    // surface, and both write the bridged hide/pin fields: handleTogglePin
    // sends { inbox_pinned_at }, handleToggleDismiss sends { inbox_stashed_at }
    // or { inbox_dismissed_at: null, inbox_stashed_at: null }. A hidden row
    // drops out of listInboxSessions, so a sibling inbox window can never learn
    // about them through the live channel either — its next whole-row put would
    // strip the flag in shared IDB and the session would climb back out of
    // Stashed. Announce the exact subset written; a patch touching none of the
    // four (rename, project switch, …) broadcasts nothing.
    const bridged = pickBridgedFields(fields);
    if (bridged) broadcastGesture({ kind: "fields", id, fields: bridged, ts: Date.now() }, bridgeUserId(this));
  }),

  // Rekey-only durable server flush. Stub writes are protected locally but
  // cannot be emitted as generic Convex patches until the real document id is
  // known. The local row already contains these values, so this action is a
  // deliberate no-op in memory; dispatch.ts validates/applies its explicit
  // field payload through the same generic conversation patch gate.
  flushResolvedSessionFields: action(function (
    _id: string,
    _fields: Record<string, any>,
  ) {}),

  _clearPostCreateBucketIntent: sync(function (
    this: Draft,
    conversationId: string,
    bucketId: string,
  ) {
    const clear = (row: any) => {
      if (row?._postCreateBucketId === bucketId) {
        delete row._postCreateBucketId;
      }
    };
    clear(this.sessions[conversationId]);
    clear(this.conversations[conversationId]);
  }),

  // Undo restores its full local snapshot in undoActions.ts. This no-op action
  // carries only the exact authoritative field tombstones/values through the
  // durable outbox; dispatch.ts applies them with the ordinary validated patch
  // gate, so a reload cannot lose the undo's server half.
  applyUndoPatches: action(function (
    _patches: Record<string, Record<string, Record<string, any>>>,
  ) {}),

  // Favorite is a plain conversation flag (server derives the favorites query
  // from is_favorite), so it rides applyPatches too. We also keep the synced
  // favorites list in sync optimistically so the sidebar updates without a
  // round-trip; the server re-derives it on the next sync.
  toggleFavorite: action(function (this: Draft, id: string) {
    const cur = this.conversations[id] ?? this.sessions[id];
    const next = !(cur as any)?.is_favorite;
    if (this.sessions[id]) (this.sessions[id] as any).is_favorite = next;
    if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
    (this.conversations[id] as any).is_favorite = next;
    const list = this.favorites as any[];
    const idx = list.findIndex((f) => f._id === id);
    if (next && idx === -1) list.push({ ...(this.conversations[id] as any) });
    else if (!next && idx !== -1) list.splice(idx, 1);
  }),

  // Privacy/visibility live in the server's immutable applyPatches set because
  // flipping them re-resolves team sharing. So these actions optimistically
  // update local state, and the matching dispatch.ts SIDE_EFFECTS do the
  // authoritative write — same split as switchProject/resumeSession.
  setPrivacy: action(function (this: Draft, id: string, isPrivate: boolean) {
    const apply = (c: any) => {
      if (!c) return;
      c.is_private = isPrivate;
      if (isPrivate) c.team_visibility = "private";
    };
    apply(this.sessions[id]);
    if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
    apply(this.conversations[id]);
  }),

  setTeamVisibility: action(function (this: Draft, id: string, visibility: "summary" | "full" | null) {
    const apply = (c: any) => {
      if (!c) return;
      c.team_visibility = visibility ?? undefined;
      c.is_private = false;
    };
    apply(this.sessions[id]);
    if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
    apply(this.conversations[id]);
  }),

  // Bookmarks are a wholesale-synced list (no field protection), so toggle the
  // local list optimistically; the toggleBookmark side-effect performs the
  // authoritative add/delete and the next sync replaces the list from server.
  toggleBookmark: action(function (this: Draft, conversationId: string, messageId: string) {
    const list = this.bookmarks as any[];
    const idx = list.findIndex((b) => b.message_id === messageId);
    const nowBookmarked = idx === -1;
    if (idx !== -1) list.splice(idx, 1);
    // Prepend (not push) so a fresh bookmark lands at the top, matching the
    // server's newest-first ordering — otherwise it would flash at the bottom
    // until the next sync re-sorts it.
    else list.unshift({ _id: `temp_${messageId}`, conversation_id: conversationId, message_id: messageId, created_at: Date.now() });
    if (!this.bookmarkPending) this.bookmarkPending = {};
    this.bookmarkPending[messageId] = { bookmarked: nowBookmarked, conversationId };
  }),

  // Manual presence status. Local-first: the roster row is the read path
  // (TeamAvatarBar's bar + hover card), so patch it in the draft — the pill
  // flips the instant it's clicked. teamMembers is wholesale-replaced on every
  // push, so myStatusPending protects the flip until the server echoes it
  // (see the teamMembers entry in SYNC_REGISTRY). The setMyStatus dispatch
  // side-effect runs the authoritative users.updateProfile.
  setMyStatus: action(function (this: Draft, status: "available" | "busy" | "away") {
    const meId = String(this.currentUser?._id ?? "");
    if (!meId) return;
    if (this.currentUser) (this.currentUser as any).status = status;
    const idx = (this.teamMembers as any[]).findIndex((m) => m && String(m._id) === meId);
    if (idx !== -1) this.teamMembers[idx] = { ...(this.teamMembers[idx] as any), status };
    this.myStatusPending = { userId: meId, status, at: Date.now() };
  }),

  // The walkie door. Local-first for the same reason as the status above, and
  // one more: useWalkieSync reads walkie_pref straight off currentUser to
  // decide whether a teammate's burst may play here, so a pref that waited on a
  // round trip would leave the door in its old state for a beat after somebody
  // deliberately shut it. No pending guard — unlike the roster row, currentUser
  // re-pushes only when the doc itself changes, by which time this IS the value.
  setWalkiePref: action(function (this: Draft, pref: "team" | "off") {
    if (this.currentUser) (this.currentUser as any).walkie_pref = pref;
  }),

  // Snooze: the shutter under that door. Same local-first reason again, and
  // more urgently — this is pressed to stop a voice that is playing RIGHT NOW,
  // so a door that waited on a round trip would let the next burst in.
  snoozeWalkie: action(function (this: Draft, until: number) {
    if (this.currentUser) (this.currentUser as any).walkie_snoozed_until = until;
    return until;
  }),

  // Notifications are a protected collection: the optimistic `read` flip is
  // field-protected so the next list sync can't revert it (the badge + bold
  // state clear instantly). The named side-effects delegate to the existing
  // notifications mutations.
  markNotificationRead: action(function (this: Draft, id: string) {
    const n = this.notifications[id] as any;
    if (n && !n.read) n.read = true;
  }),

  markAllNotificationsRead: action(function (this: Draft) {
    for (const n of Object.values(this.notifications) as any[]) {
      if (!n.read) n.read = true;
    }
  }),

  // Send a user message to Convex through the store's normal sync. As an
  // action() it rides the same persist + dispatch-outbox pipeline as every
  // other store mutation: the call is queued in the outbox before firing and
  // redriven on next load, so a reload mid-send can never drop the message
  // (dispatch.sendMessage dedups on client_id, making redelivery safe). The
  // on-screen optimistic copy is added separately via addOptimisticMessage
  // (kept durable by the persisted pendingMessages map) and pruned once the
  // server echoes it back. Fire-and-forget — status is read back from the
  // synced pending_messages row, not a return value. Args mirror the server
  // handler: [conversation_id, content, image_storage_ids, client_id].
  sendMessage: action(function (this: Draft, _convId: string, _content: string, _imageIds?: string[], _clientId?: string) {
    notePendingMessageSendRequested(_clientId);
    // A message into a session that is asking you something IS the answer —
    // a poll payload always, free text when the row says awaiting_input. Mark
    // the question resolved locally in the same commit so every question
    // surface (queue, rail section, badge) drops it before the server's
    // awaiting_input/permission_blocked truth round-trips. The mark expires
    // once the agent speaks again (lib/decisionQueue.questionResolvedLocally);
    // +1 covers this message's own echo.
    const row = this.sessions[_convId];
    const isPollAnswer = _content.startsWith("{") && _content.includes("__cc_poll");
    if (row && (isPollAnswer || row.awaiting_input)) {
      this.questionResolutions[_convId] = { at: Date.now(), message_count: (row.message_count ?? 0) + 1 };
    }
    // No other local mutation: durability for the visible message comes from
    // the persisted pendingMessages map. The middleware dispatches the args to
    // the server and queues them in the outbox.
  }),

  resumeSession: action(function (_convId: string) {}),

  sendEscape: action(function (_convId: string) {}),

  // Generic local-first session daemon-command. Routes any api.conversations.*
  // command (kill/restart/repair/reconfigure/rewind/fork/sendKeys/sendEscape)
  // through the single dispatch pipeline instead of a direct useMutation. The
  // server side-effect delegates to the existing mutation, so all its dedup /
  // pending-reset / multi-command logic is preserved (zero duplication). The
  // optional `optimistic` patch updates sessions[convId] synchronously for an
  // instant UI; asyncAction returns the server result (e.g. fork's new id), so
  // callers that await the old mutation are a drop-in swap.
  convCommand: asyncAction(function (this: Draft, convId: string, _command: string, _extraArgs?: Record<string, any>, optimistic?: Record<string, any>) {
    if (optimistic && this.sessions[convId]) Object.assign(this.sessions[convId], optimistic);
  }),

  createSession: asyncAction(function (this: Draft, opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string; linked_object?: { type: string; id: string }; model?: string; effort?: string; isolated?: boolean; worktree_name?: string; stable_mode?: string; stable_exclude?: string[]; target_device_id?: string }) {
    const sessionId = opts.session_id || (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    if (!opts.session_id) opts.session_id = sessionId;
    const existing = this.sessions[sessionId];
    const linkedObject = opts.linked_object ?? existing?._linkedObject;
    const now = Date.now();
    // model/effort ride the dispatched args (the Convex createSession handler
    // forwards them to the daemon's launch flags) AND get stamped on the local
    // row so the badge keeps the launch picker's choice through the create —
    // opts.model is the contract option key ("opus"), the row wants the full id.
    const normalizedModel = opts.model
      ? (opts.agent_type === "claude_code" ? `claude-${opts.model}` : opts.model)
      : existing?.model;
    const nextSession = {
      ...existing,
      _id: sessionId,
      session_id: sessionId,
      title: "New session",
      updated_at: now,
      started_at: existing?.started_at ?? now,
      project_path: opts.project_path,
      git_root: opts.git_root,
      agent_type: opts.agent_type,
      message_count: 0,
      is_idle: true,
      has_pending: false,
      last_user_message: null,
      ...(linkedObject ? { _linkedObject: linkedObject } : {}),
      ...(normalizedModel ? { model: normalizedModel } : {}),
      ...(opts.effort || existing?.effort ? { effort: opts.effort ?? existing?.effort } : {}),
      ...(opts.stable_mode || existing?.stable_mode ? { stable_mode: opts.stable_mode ?? existing?.stable_mode } : {}),
      ...(opts.stable_exclude?.length || existing?.stable_exclude?.length
        ? { stable_exclude: opts.stable_exclude ?? existing?.stable_exclude }
        : {}),
    } as InboxSession;
    nextSession._launchSnapshot = launchSnapshotFromRow(nextSession);
    this.sessions[sessionId] = nextSession;
  }),

  // Read the CURRENT project + agent off the stub row and create the server
  // session from those. The new-session pickers mutate the stub (updateSessionProject /
  // setConversationAgent), so the row — not the closure captured when the popup
  // opened — is the source of truth; a switch made before the first send must be
  // what we create with. `isolatedWorktreeMode` is the live toggle (global, same
  // value ProjectSwitcher reads), folded in here so "isolated worktree" applies at
  // create — the daemon's start_session makes the git worktree up front. Mirrors
  // ensureSessionCreated's read-fresh logic, but without its pathless guard (the
  // compose popup intentionally allows a project-less stub → the daemon starts in
  // $HOME). Tracking + rekey are done by beginOptimisticSession's fire() (or by
  // ensureSessionCreated), so this only creates.
  createSessionFromStub: (stubId: string, fallback?: { agentType?: string; projectPath?: string; gitRoot?: string }) => {
    const s = get();
    const cur = (s.sessions[stubId] || s.conversations[stubId]) as any;
    const projectPath = cur?.project_path ?? fallback?.projectPath;
    const gitRoot = cur?.git_root ?? fallback?.gitRoot ?? projectPath;
    const agentType = cur?.agent_type || fallback?.agentType || "claude_code";
    // Fold in the blank session's chosen model/effort. The launch picker stamps
    // these on the stub row (setConversationModel) with no server round-trip;
    // this is where the choice reaches the daemon's launch flags. The row stores
    // the full model id ("claude-opus-4-8"); the create wants the contract option
    // key ("opus") — findModelOption matches on key. A model left on a different
    // agent's id (after an agent switch) resolves to "default" and is dropped.
    const modelKey = modelOptionKey(cur?.model, agentType);
    // The machine shown in the new-session row, passed through verbatim. This
    // used to be re-checked here and DROPPED when it matched what routing would
    // pick anyway — an optimization that quietly became a bug: the picker's
    // default was decided by `last_seen`, which flips between two idle laptops
    // every ~30s, so a heartbeat landing between the click and the create could
    // discard an explicit pick and hand the choice back to a server-side
    // coin flip. The selection is now deterministic and always stamped, so
    // there is nothing left to second-guess.
    const targetDeviceId = cur?.target_device_id as string | null | undefined;
    return s.createSession({
      agent_type: agentType,
      project_path: projectPath,
      git_root: gitRoot || undefined,
      session_id: stubId,
      ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
      ...(cur?._linkedObject?.type && cur?._linkedObject?.id
        ? { linked_object: cur._linkedObject }
        : {}),
      ...(modelKey !== "default" ? { model: modelKey } : {}),
      ...(cur?.effort ? { effort: cur.effort } : {}),
      ...(s.isolatedWorktreeMode ? { isolated: true } : {}),
      // Stable-context prefs stamped on the stub by the new-session context
      // picker (setStableContextPrefs) — same lifecycle as model/effort.
      ...(cur?.stable_mode ? { stable_mode: cur.stable_mode } : {}),
      ...(cur?.stable_exclude?.length ? { stable_exclude: cur.stable_exclude } : {}),
    });
  },

  // Optimistic session creation, shared by every new-session entry point (the
  // in-app quick-create, the compose popup, and the New Session modal). Seeds a
  // local conversation under a non-Convex stub id SYNCHRONOUSLY so the caller can
  // navigate to it and render the user's first message as pending with zero
  // network in the critical path, then rekeys stub → real id when `create`
  // resolves. `create` is injected so callers pick the backend (store.createSession
  // for normal sessions, the createQuickSession mutation when isolated/worktree
  // options are needed). The stub uses the same Math.random id scheme as
  // createSession — never 32 chars, so isConvexId() correctly treats it as local.
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; reuse?: boolean; deferCreate?: boolean; create: (stubId: string) => Promise<string> }) => {
    const store = get();
    // Only an INCLUDE label chip files new sessions — excluding a label means
    // "hide it", never "file new work there".
    const bucketAtCreate = store.chipFilterExclude ? null : store.activeBucketFilter;
    // Converge on the existing blank session for this project+agent instead of
    // minting another one — repeated summon/abandon cycles otherwise strand an
    // empty "New Session" row (and a pre-warmed daemon process) per summon.
    if (opts.reuse) {
      const existing = findReusableBlankSession(store as any, opts);
      if (existing) {
        const pendingCreate = store.pendingSessionCreates[existing];
        const ready = pendingCreate ?? Promise.resolve(existing);
        // A reused blank summoned inside a focused bucket files there too —
        // unless it was already filed somewhere by hand.
        const existingAssignment = (
          Object.values(store.bucketAssignments) as BucketAssignmentItem[]
        ).find((row) => row.conversation_id === existing);
        if (bucketAtCreate && !existingAssignment) {
          const existingSession = store.sessions[existing];
          const existingConversation = store.conversations[existing];
          if (existingSession) {
            store.syncRecord("sessions", existing, {
              ...existingSession,
              _postCreateBucketId: bucketAtCreate,
            });
          }
          if (existingConversation) {
            store.syncRecord("conversations", existing, {
              ...existingConversation,
              _postCreateBucketId: bucketAtCreate,
            });
          }
          ready.then((id: string) => {
            const real = get().getConvexId(id) ?? id;
            resumePostCreateBucketIntentFor(real, bucketAtCreate);
          }).catch(() => {});
        }
        return { stubId: existing, ready, materialize: () => ready };
      }
    }
    const stubId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    store.syncRecord("conversations", stubId, {
      _id: stubId, _creationTime: now, user_id: "", agent_type: opts.agentType,
      session_id: stubId, project_path: opts.projectPath, git_root: opts.gitRoot,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
      ...(bucketAtCreate ? { _postCreateBucketId: bucketAtCreate } : {}),
    });
    // Also seed the inbox session row. The conversation page resolves a stub from
    // sessions[id] (local-first, before the server resolver loads), so without this
    // a navigate-to-stub would flash a loading skeleton then "Not Found". This mirrors
    // what store.createSession seeds — callers using the createQuickSession mutation
    // (which doesn't touch the store) rely on it. session_id === stubId so the server
    // resolver (by_session_id) also maps the stub once the create lands.
    store.syncRecord("sessions", stubId, {
      _id: stubId, session_id: stubId, title: "New session",
      updated_at: now, started_at: now, project_path: opts.projectPath,
      git_root: opts.gitRoot, agent_type: opts.agentType, message_count: 0,
      is_idle: true, has_pending: false, last_user_message: null,
      ...(bucketAtCreate ? { _postCreateBucketId: bucketAtCreate } : {}),
    });
    // Capture the focused bucket NOW: a session created while a bucket chip is
    // active belongs to that bucket. Assignment waits for the real id (the
    // server side effect can't act on stubs).
    // The actual server create — fired now, or deferred to materialize(). Wrapped
    // in a once-guard so a deferred stub's create fires exactly once no matter how
    // many times materialize() is called (e.g. typed-then-sent, or both the draft
    // and submit triggers racing).
    let fired = false;
    let readyPromise: Promise<string> | null = null;
    const fire = (): Promise<string> => {
      if (fired) return readyPromise as Promise<string>;
      fired = true;
      const ready = opts.create(stubId).then((convexId: string) => {
        if (convexId) {
          store.resolveSessionId(stubId, convexId);
        }
        return convexId;
      });
      store.trackSessionCreate(stubId, ready);
      // Callers attach their own handling; swallow here so an unobserved create
      // failure doesn't surface as an unhandled rejection.
      ready.catch(() => {});
      readyPromise = ready;
      return ready;
    };
    // Deferred: the stub exists locally but no server conversation is created
    // until materialize() runs. An abandoned (never-materialized) stub carries no
    // pendingSessionCreates entry, so pruneGhostSessions can hard-drop it cleanly.
    const ready = opts.deferCreate ? Promise.resolve(stubId) : fire();
    return { stubId, ready, materialize: fire };
  },

  updateClientUI: action(function (this: Draft, partial: Partial<ClientUI>) {
    // Whitelisted per-USER keys get a flat "<key>:ts" sibling stamp so the ui
    // bag can merge them per-key LWW (mergeStampedBagLww) — the inbox view
    // follows the user across devices, and the newest toggle anywhere wins
    // everywhere. A caller-supplied stamp is honored (the hydration gap-fill
    // restores legacy values with their ORIGINAL write time, so a stale boot
    // can't outrank a genuinely newer cross-device write).
    const stamped: Record<string, any> = { ...partial };
    const now = Date.now();
    for (const k of Object.keys(partial)) {
      if (STAMPED_UI_KEYS.has(k) && stamped[`${k}:ts`] === undefined) stamped[`${k}:ts`] = now;
    }
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    Object.assign(this.clientState.ui, stamped);
    writeCriticalUiPrefs(stamped);
    // The server-side named handler replays this exact client-stamped payload
    // even when Object.assign produced no local patch (already-equal state).
    return stamped;
  }),

  // Saved views are a server collection now, so they can be shared. All three
  // writes are local-first: the row renders from the draft immediately and the
  // server echo reconciles, superseding the stub via the client_key altKey.
  createSavedView: action(function (this: Draft, opts: {
    name: string;
    page: "tasks" | "docs" | "plans" | "workspace";
    prefs: any;
    shared?: boolean;
    icon?: string;
    client_key?: string;
    team_id?: string;
  }) {
    // MUTATE opts, don't just return the enriched copy: the dispatch forwards
    // the original args to the server, so anything computed only into the return
    // value never leaves this machine. That is what made shared views invisible
    // to teammates — every row reached the server with no team_id, so the
    // by_team_id query on their side could never find it.
    if (!opts.client_key) {
      opts.client_key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    const teamId = this.clientState.ui?.active_team_id;
    if (teamId && opts.team_id === undefined) opts.team_id = teamId;
    // Sharing needs a team to share with; without one the row stays personal.
    opts.shared = !!opts.shared && !!opts.team_id;
    const key = opts.client_key;
    const stubId = `temp_view_${key}`;
    this.savedViews[stubId] = {
      _id: stubId,
      client_key: key,
      team_id: opts.team_id,
      name: opts.name,
      page: opts.page,
      prefs: opts.prefs ?? {},
      shared: opts.shared,
      icon: opts.icon,
      is_mine: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    } as SavedViewRow;
    return { ...opts };
  }),

  updateSavedView: action(function (this: Draft, id: string, fields: Record<string, any>) {
    const row = (this.savedViews as any)[id];
    if (row) Object.assign(row, fields, { updated_at: Date.now() });
  }),

  deleteSavedView: action(function (this: Draft, id: string) {
    delete (this.savedViews as any)[id];
  }),

  updateClientLayout: action(function (this: Draft, key: string, value: any) {
    if (!this.clientState.layouts) this.clientState.layouts = {};
    (this.clientState.layouts as any)[key] = value;
  }),

  // action(): the patch rides the outbox (the old hand-rolled _dispatch had one
  // 3s retry and no replay — a failed write left this client permanently
  // diverged from the server). The ":ts" stamp is what lets the LWW merge sync
  // the preference across devices (mergeStampedBagLww).
  updateClientDismissed: action(function (this: Draft, key: string, value: any) {
    if (!this.clientState.dismissed) this.clientState.dismissed = {};
    const bag = this.clientState.dismissed as Record<string, any>;
    bag[key] = value;
    bag[`${key}:ts`] = Date.now();
  }),

  _applyClientTips: sync(function (this: Draft, partial: Partial<ClientTips>) {
    if (!this.clientState.tips) this.clientState.tips = {} as ClientTips;
    const tips = this.clientState.tips;
    if (partial.seen) tips.seen = partial.seen;
    if (partial.dismissed) tips.dismissed = partial.dismissed;
    if (partial.completed) tips.completed = partial.completed;
    if (partial.level !== undefined) tips.level = partial.level;
    if (partial._inlineSuppressed !== undefined) tips._inlineSuppressed = partial._inlineSuppressed;
  }),

  updateClientTips: (partial: Partial<ClientTips>) => {
    (get() as any)._applyClientTips(partial);
    const serverPartial = { ...partial };
    delete serverPartial._inlineSuppressed;
    if (Object.keys(serverPartial).length > 0) {
      (get() as any).persistClientTips(serverPartial);
    }
  },

  // The public wrapper above performs one exact local sync (including the
  // device-only _inlineSuppressed flag). This named no-op action durably carries
  // only the cross-device subset; dispatch.ts builds the validated client_state
  // patch without ever leaking the local suppression bit.
  persistClientTips: action(function (_partial: Partial<ClientTips>) {}),

  // =====================
  // GENERIC SYNC
  // =====================

  // Cross-team mention index — rebuild the slice from the latest server
  // snapshot. Replaces wholesale by design: each `webMentionList` query
  // returns the full set of records the user can see, so swapping the map
  // is both correct and the cheapest way to handle deletions.
  syncMentionIndex: sync(function (this: Draft, kind: "tasks" | "docs" | "plans", items: any[]) {
    if (!items) return;
    const next: Record<string, any> = {};
    for (const it of items) {
      if (it && it._id) next[String(it._id)] = it;
    }
    if (!this.mentionIndex) this.mentionIndex = { tasks: {}, docs: {}, plans: {} } as any;
    (this.mentionIndex as any)[kind] = next;
  }),

  // Team activity feed = a liberal, accumulating cache (the read source for the
  // feed, just like store.sessions backs the personal feed). Both the live query
  // (newest page) and "Load more" (older pages) dump here; we overlay by _id so
  // updates and paginated pages merge without ever losing a row, then keep it
  // sorted newest-first. UNBOUNDED on purpose: every row a page ever fetched
  // stays cached. The feed's exhaustiveness rests on this — a cap silently
  // dropped the oldest rows once a deep scroll crossed it, and the catch-up
  // walk (lib/feedCatchup) counts on cached rows below the watermark staying
  // put. sync() = local draft + IDB write, no server dispatch.
  mergeFeedConversations: sync(function (this: Draft, key: string, convs: any[]) {
    const byId = new Map((this.feedConversations[key] ?? []).map((c: any) => [c._id, c]));
    for (const c of convs ?? []) byId.set(c._id, c);
    this.feedConversations[key] = [...byId.values()]
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }),

  // Whether older pages remain for this feed key (persisted so the "Load more"
  // affordance is correct on cold open without first probing the server).
  setFeedHasMore: sync(function (this: Draft, key: string, hasMore: boolean) {
    this.feedHasMore[key] = hasMore;
  }),

  // Server-issued continuation cursor for the next older page (null = the
  // server confirmed true end-of-history). Persisted so pagination resumes
  // exactly where it stopped instead of re-deriving from the oldest cached row.
  setFeedCursor: sync(function (this: Draft, key: string, cursor: string | null) {
    this.feedCursors[key] = cursor;
  }),

  // Advance the per-workspace incremental-sync watermark. sync() = local draft +
  // IDB write, no server dispatch — this is purely local bookkeeping. `cursor`
  // only ever moves FORWARD (max) so a late/out-of-order delta can't rewind it
  // and cause already-synced rows to be re-fetched; `backfilledAt` is set wholesale.
  recordSyncMeta: sync(function (this: Draft, key: string, patch: { cursor?: number; backfilledAt?: number; resumeCursor?: string | null; resumeAt?: number }) {
    const prev = this.syncMeta[key] ?? {};
    const next = { ...prev };
    if (typeof patch.cursor === "number" && (prev.cursor === undefined ? patch.cursor >= 0 : patch.cursor > prev.cursor)) next.cursor = patch.cursor;
    if (typeof patch.backfilledAt === "number") next.backfilledAt = patch.backfilledAt;
    // Mid-crawl checkpoint (reconcileCrawl): the continuation cursor of an
    // interrupted backfill, so a reload resumes instead of re-walking from page
    // zero. Unlike `cursor` this may move to any value, and null clears it.
    if ("resumeCursor" in patch) {
      next.resumeCursor = patch.resumeCursor ?? undefined;
      next.resumeAt = patch.resumeCursor == null ? undefined : patch.resumeAt;
    }
    this.syncMeta[key] = next;
  }),

  syncTable: sync(function (this: Draft, field: string, incoming: any, opts?: SyncOpts) {
    if (!incoming && incoming !== 0) return;
    const config = SYNC_REGISTRY[field] ? { ...SYNC_REGISTRY[field], ...opts } : (opts || {});
    const kind = config.kind ?? "collection";

    if (kind === "scalar" || kind === "list") {
      if (config.normalize) incoming = config.normalize(incoming, this);
      // No-op re-pushes are common — a list-kind subscription re-emits on any
      // read-set change (teamMembers was measured re-pushing ~every 2s on
      // presence heartbeats) — and a wholesale assign registers as a change:
      // every subscriber wakes and the persistence layer re-puts the whole meta
      // blob to IDB. Bail when the payload is value-identical. Skipped when a
      // transform/extra is registered (bookmarks reconciles local pending state
      // even against an identical payload). These lists are small rosters, so
      // the JSON compare is far cheaper than the wake + IDB put it avoids.
      if (!config.transform && !config.extra) {
        const current = (this as any)[field];
        if (Object.is(current, incoming)) return;
        if (kind === "list" && Array.isArray(current) && Array.isArray(incoming) &&
            JSON.stringify(current) === JSON.stringify(incoming)) return;
      }
      (this as any)[field] = incoming;
      if (config.transform) config.transform(this, incoming, incoming, false);
      if (config.extra) Object.assign(this, config.extra);
      return;
    }

    if (kind === "singleton") {
      if (config.normalize) incoming = config.normalize(incoming, this);
      const local = (this as any)[field];
      const initKey = `${field}Initialized`;
      const initialized = (this as any)[initKey] ?? false;
      // Same no-op bail as list-kind above: currentUser re-pushes on every
      // users-doc heartbeat (last_seen), and each accepted push is a new object
      // identity that wakes every subscriber. `local &&` keeps the first real
      // write landing (and setting the init flag below) unconditionally.
      if (!config.transform && !config.merge && !config.extra &&
          local && incoming && JSON.stringify(local) === JSON.stringify(incoming)) {
        return;
      }
      const result = config.merge
        ? applyMerge(local, incoming, config.merge, initialized)
        : incoming;
      (this as any)[field] = result;
      if (config.transform) config.transform(this, result, incoming, initialized);
      if (initKey in this) (this as any)[initKey] = true;
      if (config.extra) Object.assign(this, config.extra);
      return;
    }

    // collection
    // A non-array here is a broken contract, not data: a field renamed out of
    // the registry while a stale feeder still pushes its old scalar (an HMR
    // batch re-ran the old useChatSync against the new registry and sent
    // `chatThreadUnread: 0` down this path), or a server shape change inside
    // a deploy window. Drop the push and keep the cached rows — throwing here
    // unmounted the whole DashboardSyncEffects boundary, which stops EVERY
    // feeder, not just the bad one.
    if (!Array.isArray(incoming)) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`[sync] ${field}: collection push is not an array (${typeof incoming}); dropped`);
      }
      return;
    }
    // Read the previous collection and pending map from the BASE state, not
    // through the draft: applySyncTable walks every row of prev, and each read
    // through the mutative proxy allocates a child draft (a 14k-row docs
    // collection × every crawl page made this the top idle cost). The
    // decision is made on plain objects; only the final assignment touches the
    // draft.
    const base: any = isDraft(this) ? original(this) : this;
    const prevCollection = base[field] || {};
    let { table, pending } = applySyncTable(
      field, incoming, base.pending, prevCollection,
      (config.isDelta || config.ignoreFields || config.preserveFields || config.pruneAbsentScope)
        ? {
            isDelta: config.isDelta,
            ignoreFields: config.ignoreFields,
            preserveFields: config.preserveFields,
            pruneAbsentScope: config.pruneAbsentScope,
          }
        : undefined,
    );

    if (config.altKey) {
      // applySyncTable hands back the BASE table/pending objects when a push
      // changed nothing. The rekey below mutates in place, so copy on first
      // write — never touch base state, and keep the untouched identity (no
      // subscriber wake) when no stub matched.
      const mutTable = () => { if (table === prevCollection) table = { ...table }; return table; };
      const mutPending = () => { if (pending === base.pending) pending = { ...pending }; return pending; };
      const incomingByAlt = new Map(
        (incoming as any[]).map((r: any) => [r[config.altKey!], r])
      );
      for (const [oldId, old] of Object.entries(prevCollection)) {
        if (isConvexId(oldId)) continue;
        const match = incomingByAlt.get((old as any)[config.altKey!] || oldId);
        if (match) {
          const launchReconfigure =
            field === "sessions" ? pendingLaunchReconfigure(old) : null;
          rekeyId(this, oldId, match._id);
          rekeyPending(mutPending(), oldId, match._id);
          if (oldId !== match._id && table[oldId]) {
            mutTable();
            if (!table[match._id]) {
              table[match._id] = { ...(table[oldId] as any), _id: match._id };
            } else if (config.preserveFields) {
              // applySyncTable can only preserve an overlay field when prev and
              // incoming share an id. An alt-key match is the stub→real case:
              // carry those same local-only fields across before discarding the
              // old row, or a reload-time rekey drops durable post-create intent.
              for (const field of config.preserveFields) {
                if (
                  (table[match._id] as any)[field] == null &&
                  (table[oldId] as any)[field] != null
                ) {
                  table[match._id] = {
                    ...(table[match._id] as any),
                    [field]: (table[oldId] as any)[field],
                  };
                }
              }
            }
            delete table[oldId];
          }
          // Reapply field overrides that applySyncTable missed (it ran
          // before the pending entries were rekeyed to the new ID).
          const fp = `${field}:${match._id}:`;
          for (const [key, entry] of Object.entries(pending)) {
            if (entry.type !== "field" || !key.startsWith(fp)) continue;
            if (table[match._id]) {
              mutTable()[match._id] = { ...(table[match._id] as any), [key.slice(fp.length)]: entry.value };
            }
          }
          if (field === "sessions" && isConvexId(match._id)) {
            // sync() commits after this recipe returns. A timer makes the
            // continuation observe the rekeyed store and keeps dispatch out of
            // the incoming-data transaction itself.
            scheduleResolvedSessionContinuations(match._id, launchReconfigure);
          }
          if (field === "chatChannels" && isConvexId(match._id)) {
            scheduleResolvedChatChannelSends(match._id);
          }
        } else if (!table[oldId]) {
          mutTable()[oldId] = old as any;
        }
      }
    }

    if (config.keepSelected) {
      const selectedId = (this as any)[config.keepSelected];
      if (selectedId && !table[selectedId] && prevCollection[selectedId]) {
        // table !== prevCollection here (prev has the row, table doesn't).
        table[selectedId] = prevCollection[selectedId];
      }
    }

    // No-op push: nothing to commit. Decided by ROW IDENTITY — applySyncTable
    // hands back the previous row object whenever nothing it compares changed
    // — never by `updated_at` alone: a table whose rows carry no updated_at
    // (agent_tasks) made every push after the first look identical
    // (undefined === undefined) and silently dropped real changes. And the
    // pending map must land even when the rows didn't: an echo that CLEARS a
    // local-first field protection changes pending, not the table.
    if (!config.altKey && !config.extra && !config.transform && base.pending === pending) {
      if (prevCollection) {
        const newKeys = Object.keys(table);
        if (newKeys.length === Object.keys(prevCollection).length &&
            newKeys.every(k => prevCollection[k] === table[k])) {
          return;
        }
      }
    }

    // applySyncTable returns the PREVIOUS table/pending objects untouched when
    // a push changed nothing (whole-collection identity reuse) — skip the draft
    // writes so a no-op sync produces no commit at all.
    if (base[field] !== table) (this as any)[field] = table;
    if (base.pending !== (pending as any)) this.pending = pending as any;
    if (field === "bucketAssignments") {
      for (const row of Object.values(table) as BucketAssignmentItem[]) {
        if (!isConvexId(String(row._id))) continue;
        const clear = (session: any) => {
          // A real assignment row (including an explicit unfile tombstone or a
          // different bucket selected later) supersedes the one-shot marker.
          if (session?._postCreateBucketId) {
            delete session._postCreateBucketId;
          }
        };
        clear(this.sessions[row.conversation_id]);
        clear(this.conversations[row.conversation_id]);
      }
    }
    if (config.transform) config.transform(this, table, incoming, false, prevCollection);
    if (config.extra) Object.assign(this, config.extra);
  }),

  syncRecord: sync(function (this: Draft, field: string, id: string, record: any) {
    // Apply pending protection: local-first field values win over server
    const { record: protectedRecord, pending: newPending } =
      applySyncRecord(field, id, record, this.pending);
    this.pending = newPending as any;

    // Exclude pending — entire record blocked from sync
    const excludeKey = `${field}:${id}`;
    if (this.pending[excludeKey]?.type === "exclude") return;

    const collection = (this as any)[field];
    const existing = collection?.[id];

    // Bail out if every incoming property already matches — avoids creating
    // a new state reference, which would cascade through useTrackedStore →
    // storeMeta → conversation prop → ConversationView re-render → Radix
    // tooltip ref loop under React 19's ref cleanup semantics.
    if (existing && protectedRecord) {
      const keys = Object.keys(protectedRecord);
      if (keys.length > 0 && keys.every(k => Object.is(existing[k], protectedRecord[k]))) {
        return;
      }
    }

    // Mutate draft in-place instead of replacing the collection object.
    // This ensures mutative only marks the changed subtree as dirty.
    if (!collection) {
      (this as any)[field] = { [id]: protectedRecord };
    } else if (!existing) {
      collection[id] = protectedRecord;
    } else {
      for (const key of Object.keys(protectedRecord)) {
        if (!Object.is(existing[key], protectedRecord[key])) {
          existing[key] = protectedRecord[key];
        }
      }
    }
  }),

  dropDocDetail: sync(function (this: Draft, id: string) {
    if (this.docDetails[id]) delete this.docDetails[id];
  }),

  // Local-first retire of the "assigned to you" ping: the UI clears it the
  // moment the user acks, while the ackSessionAssignment mutation round-trips;
  // the next inbox sync reflects the server's cleared state and agrees.
  clearAssignedPing: sync(function (this: Draft, conversationId: string) {
    const row = this.sessions[conversationId];
    if (row?.assigned_ping) row.assigned_ping = null;
  }),

  // Merge a small high-churn map (e.g. heartbeat liveness keyed by id) onto a
  // base collection's existing rows, touching only changed fields so unchanged
  // rows keep object identity (React.memo holds). The base list owns the stable
  // fields; the overlay carries only the churny ones (agent_status, is_idle,
  // updated_at, …). This is the generic "split liveness out of the row" verb —
  // sessions, tasks, and feedSessions all merge their activity overlay through
  // this one path instead of bundling liveness into the heavyweight list
  // payload (which forces a full O(N) re-push of the whole collection on every
  // ~1s heartbeat). Rows the base doesn't have yet are skipped — an overlay
  // never creates a row, it only annotates one.
  syncOverlay: sync(function (this: Draft, field: string, overlayById: Record<string, Record<string, any>>) {
    const collection = (this as any)[field];
    if (!collection) return;
    for (const id in overlayById) {
      const row = collection[id];
      if (!row) continue;
      const fields = overlayById[id];
      for (const key in fields) {
        if (!Object.is(row[key], fields[key])) row[key] = fields[key];
      }
    }
  }),


  sortedSessions: () => {
    return sortSessions(get().sessions).filter((s: InboxSession) => !s.is_subagent && !s.parent_conversation_id);
  },

  visualOrder: () => computeVisualOrder(get()),

  // =====================
  // NAVIGATION
  // =====================

  advanceToNext: () => {
    const ordered = get().visualOrder();
    const currentId = get().currentSessionId;
    const idleSessions = ordered.filter((s: InboxSession) => isSessionWaitingForInput(s));
    const currentIdleIdx = idleSessions.findIndex((s: InboxSession) => s._id === currentId);
    const nextIdle = idleSessions[currentIdleIdx + 1] || idleSessions[0];
    if (nextIdle && nextIdle._id !== currentId) {
      get().setCurrentSession(nextIdle._id);
    }
  },

  navigateUp: () => {
    get().freezeRecentForNav();
    const ordered = get().visualOrder();
    if (ordered.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = ordered.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = Math.max(idx - 1, 0);
    if (newIdx === idx) return;
    get().navigateToSession(ordered[newIdx]._id);
  },

  navigateDown: () => {
    get().freezeRecentForNav();
    const ordered = get().visualOrder();
    if (ordered.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = ordered.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = Math.min(idx + 1, ordered.length - 1);
    if (newIdx === idx) return;
    get().navigateToSession(ordered[newIdx]._id);
  },

  freezeRecentForNav: () => {
    if (resolveInboxViewMode(get().clientState.ui) !== "recent") return;
    // Snapshot the live order once; later presses within the window just re-arm
    // the thaw timer so the same frozen order keeps being walked.
    if (!get().recentFreezeOrder) {
      set({ recentFreezeOrder: get().visualOrder().map((s: InboxSession) => s._id) });
    }
    if (recentThawTimer) clearTimeout(recentThawTimer);
    recentThawTimer = setTimeout(() => get().thawRecentOrder(), RECENT_FREEZE_THAW_MS);
  },

  thawRecentOrder: () => {
    if (recentThawTimer) { clearTimeout(recentThawTimer); recentThawTimer = null; }
    if (get().recentFreezeOrder) set({ recentFreezeOrder: null });
  },

  setCurrentSession: action(function (this: Draft, id: string, source: ViewNavSource = "gesture") {
    // A Cmd-click on a session row opens it in a background tab / detached
    // window (lib/openIntent) — the visible conversation must not move.
    if (source === "gesture" && divertSessionOpen(id)) return;
    // "adopt" is machine selection (a fallback picking a view because none
    // exists). It is boot-only by policy: never before hydration restored the
    // client's own position, and never once ANY view has been shown this
    // window lifetime — a mid-session adopt is exactly the "random jump".
    if (source === "adopt" && (!this.clientStateInitialized || hasViewNavigated())) {
      recordNavEvent({
        field: "currentSessionId",
        from: this.currentSessionId ?? null,
        to: id,
        source,
        blocked: this.clientStateInitialized ? "adopt after first view" : "adopt before hydration",
      });
      return;
    }
    declareViewNav(source);
    commitCurrentSession(this, id);
  }),

  clearSelection: action(function (this: Draft) {
    this.viewingDismissedId = null;
  }),

  toggleCollapsedSection: action(function (this: Draft, key: string) {
    this.collapsedSections = { ...this.collapsedSections, [key]: !this.collapsedSections[key] };
  }),

  // Raw set: ephemeral nav bookkeeping — no draft, no persistence, no dispatch.
  setScheduleNavSets: (sets: ScheduleNavSets | null) =>
    set({ scheduleNavSets: sets }),

  // Raw set: one-shot strip-expand request (see the state field's comment).
  setScheduleStripExpand: (req: { convId: string; nonce: number } | null) =>
    set({ scheduleStripExpand: req }),

  // Raw set: one-shot composer seed (see the state field's comment).
  setComposerPrefill: (req: { convId: string; text: string } | null) =>
    set({ composerPrefill: req }),

  setViewingDismissedId: action(function (this: Draft, id: string | null) {
    if (id && divertSessionOpen(id)) return;
    this.viewingDismissedId = id;
  }),

  getCurrentSession: () => {
    const { sessions, currentSessionId } = get();
    if (!currentSessionId) return null;
    return sessions[currentSessionId] ?? null;
  },

  injectSession: action(function (this: Draft, session: InboxSession) {
    // Dismiss/stash are absolute — never altered by viewing. If the injected
    // session arrived hidden, surface it through viewingDismissedId so the user
    // can read it without resurrecting it into the active inbox.
    //
    // Never DOWNGRADE a cached row: callers build inject payloads from narrow
    // projections (deep link, palette), so an existing row is the richer
    // record — keep its values and let the payload only fill gaps. Writing the
    // thin payload over a synced row is how a stashed/pinned session loses its
    // triage stamps and flashes into the inbox as an active card at boot
    // (ct-42666). All callers currently guard on !sessions[id]; this makes the
    // invariant hold regardless of caller discipline.
    const existing = this.sessions[session._id];
    const merged: InboxSession = { ...session };
    if (existing) {
      for (const k of Object.keys(existing) as (keyof InboxSession)[]) {
        if (existing[k] !== undefined) (merged as any)[k] = existing[k];
      }
    }
    this.sessions[session._id] = merged;
    if (isSessionHidden(merged)) {
      this.viewingDismissedId = session._id;
    } else {
      declareViewNav("gesture");
      commitCurrentSession(this, session._id);
    }
  }),

  // Seed branch (fork) sessions into the local cache WITHOUT navigating, so a
  // later branch-chip click switches instantly instead of routing through the
  // pendingNavigate → getConversation fetch → injectSession path (the source of
  // the "branch spins forever" hang on a cold cache). Gap-fill only: an existing
  // live row is never downgraded by a thin stub. Authoritative metadata + the
  // message list reconcile via the normal getConversationWithMeta + listMessages
  // subscriptions the moment the branch is actually viewed. sync() (not action())
  // because this is incoming-data seeding, not a user edit — it persists to IDB
  // (branches stay preloaded across reloads) but dispatches nothing to the server.
  preloadForkSessions: sync(function (this: Draft, forks: ForkChild[], forkedFrom?: string) {
    for (const f of forks) {
      const id = f?._id;
      if (!id || !isConvexId(id)) continue;               // skip optimistic/stub ids
      if (this.pending[`sessions:${id}`]?.type === "exclude") continue; // killed locally
      const existing = this.sessions[id];
      if (existing) {
        // Don't clobber live data — but DO heal a row seeded before payloads
        // carried triage state: fill exactly the stamp keys this payload
        // delivers into fields the row never had (undefined = never delivered;
        // an explicit null is a real "not stashed/dismissed" and stays). This
        // is what retires the stampless stubs persisted in old caches.
        for (const k of TRIAGE_STAMP_KEYS) {
          if (f[k] !== undefined && (existing as any)[k] === undefined) {
            (existing as any)[k] = f[k] ?? null;
            if (k === "inbox_pinned_at" && existing.is_pinned === undefined) {
              existing.is_pinned = !!f[k];
            }
          }
        }
        continue;
      }
      if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
      this.sessions[id] = sessionRowFromSummary({
        ...f,
        forked_from: f.forked_from ?? forkedFrom ?? null,
      });
    }
  }),

  updateSessionProject: action(function (this: Draft, id: string, projectPath: string) {
    if (this.sessions[id]) {
      this.sessions[id].project_path = projectPath;
      this.sessions[id].git_root = projectPath;
    }
    if (!this.conversations[id]) {
      this.conversations[id] = { _id: id } as any;
    }
    this.conversations[id].project_path = projectPath;
    this.conversations[id].git_root = projectPath;
  }),

  patchSession: sync(function (this: Draft, id: string, fields: Partial<InboxSession>) {
    if (!this.sessions[id]) return;
    Object.assign(this.sessions[id], fields);
  }),

  // The machine row's stamp. Local-only (`sync`): the conversations table has no
  // such column — the value's only job is to survive on the stub row until
  // createSessionFromStub reads it. Null clears a pick the user reverted.
  setSessionTargetDevice: sync(function (this: Draft, id: string, deviceId: string | null) {
    if (this.sessions[id]) this.sessions[id].target_device_id = deviceId;
    if (this.conversations[id]) (this.conversations[id] as any).target_device_id = deviceId;
  }),

  setConversationAgent: sync(function (this: Draft, id: string, agentType: string) {
    if (this.sessions[id]) this.sessions[id].agent_type = agentType;
    if (this.conversations[id]) this.conversations[id].agent_type = agentType;
    if (this.currentConversation.conversationId === id) {
      this.currentConversation.agentType = agentType;
    }
  }),

  setConversationModel: sync(function (this: Draft, id: string, opts: { model?: string | null; effort?: string | null }) {
    for (const row of [this.sessions[id], this.conversations[id]] as any[]) {
      if (!row) continue;
      if (opts.model !== undefined) row.model = opts.model ?? undefined;
      if (opts.effort !== undefined) row.effort = opts.effort ?? undefined;
    }
  }),

  setStableContextPrefs: sync(function (this: Draft, id: string, prefs: { mode?: string | null; exclude?: string[] | null }) {
    for (const row of [this.sessions[id], this.conversations[id]] as any[]) {
      if (!row) continue;
      if (prefs.mode !== undefined) row.stable_mode = prefs.mode ?? undefined;
      if (prefs.exclude !== undefined) row.stable_exclude = prefs.exclude?.length ? prefs.exclude : undefined;
    }
  }),

  navigateToSession: action(function (this: Draft, id: string, source: ViewNavSource = "gesture") {
    // Plain navigation. Forks are first-class conversations — clicking one
    // (in the sidebar, BranchSelector, or a deep link) just sets it as the
    // current conversation. No overlay-on-parent state to keep in sync.
    //
    // Dismiss/stash are absolute: navigation NEVER clears them.
    // Deep-link / URL `?s=` / popstate / palette / desktop window-focus all
    // funnel through here, and silently resurrecting a dismissed session was
    // the long-running "dismiss doesn't stick" bug. A hidden target is
    // shown through `viewingDismissedId` (the same view-only path the inbox
    // sidebar uses when you click a session under "Stashed"/"Dismissed"); only
    // an explicit `restoreSession` or sending a message clears the flags.
    if (source === "gesture" && divertSessionOpen(id)) return;
    declareViewNav(source);
    const session = this.sessions[id];
    if (session) {
      if (isSessionHidden(session)) {
        this.viewingDismissedId = id;
      } else {
        commitCurrentSession(this, id);
      }
    } else {
      this.pendingNavigateId = id;
      this.viewingDismissedId = null;
    }
  }),

  // The pendingNavigateId channel as one tagged action: target + scroll target
  // set atomically (setting them separately raced the inbox's cache-hit
  // watcher onto the previous conversation). All UI "go to message X in
  // conversation Y" affordances funnel here — raw setState writes to these
  // fields are reverted by the middleware's view guard.
  requestNavigate: action(function (
    this: Draft,
    id: string,
    opts?: {
      scrollToMessageId?: string | null;
      scrollToMessageTimestamp?: number | null;
      highlightQuery?: string | null;
      showMySessions?: boolean;
      source?: ViewNavSource;
    },
  ) {
    if ((opts?.source ?? "gesture") === "gesture" && divertSessionOpen(id, { messageId: opts?.scrollToMessageId })) return;
    declareViewNav(opts?.source ?? "gesture");
    this.pendingNavigateId = id;
    if (opts && "scrollToMessageId" in opts) this.pendingScrollToMessageId = opts.scrollToMessageId ?? null;
    if (opts && "scrollToMessageTimestamp" in opts) this.pendingScrollToMessageTimestamp = opts.scrollToMessageTimestamp ?? null;
    if (opts && "highlightQuery" in opts) this.pendingHighlightQuery = opts.highlightQuery ?? null;
    if (opts?.showMySessions === false) this.showMySessions = false;
  }),

  // Public "I am now viewing `id` as the current session" — delegates to the
  // shared recorder so it persists (action() → IDB) and updates the divider
  // anchor. Used by the inbox effect + restore paths; the navigation primitives
  // above already record on their own.
  touchMru: action(function (this: Draft, id: string) {
    recordSessionView(this, id, this.currentSessionId);
  }),

  markKilling: action(function (this: Draft, id: string) {
    let newSessionId = this.currentSessionId;
    if (this.currentSessionId === id) {
      const next = nextSessionPastRemoved(computeVisualOrder(this), id, new Set([id]));
      newSessionId = next?._id ?? null;
    }
    delete this.sessions[id];
    // Killing an already-dismissed session HARD-REMOVES its inbox row, so a
    // sibling window still holding that row would re-put it and the killed card
    // would come back (gestureBridge.ts). Scoped to the session row because
    // that is all this action drops — the conversation stays cached.
    broadcastGesture({ kind: "forget", ids: [id], scope: "session-row", ts: Date.now() }, bridgeUserId(this));
    declareViewNav("gesture");
    this.currentSessionId = newSessionId;
    recordCurrentConversationPointer(this, newSessionId ?? undefined);
    // Same lockstep as commitCurrentSession / hideSessionInDraft: advancing the
    // selection must rewrite the active inbox tab's `?s=`, or the re-assert effect
    // snaps the view back onto the just-removed session.
    syncActiveInboxTabPath(this, newSessionId);
  }),


  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: sync(function (this: Draft, convId: string, msgs: Message[], meta?: Partial<PaginationState>) {
    msgs = dedupeReplayedMessages(msgs);
    prunePendingEchoes(this, convId, msgs);
    // Server data only — pending messages are merged at read time.
    //
    // Preserve any local messages with timestamps strictly newer than the
    // incoming batch's newest. The paginated `listMessages` subscription is
    // DESC-ordered and its first page covers the newest N items, but its
    // reactivity can briefly stall while a recovery fetch (see
    // useConversationMessages) has already merged in even-newer items.
    // Without this guard, the next paginated tick clobbers them and the
    // user sees the conversation snap backward.
    const existing = this.messages[convId] || [];
    const incomingNewestTs = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : -Infinity;
    const incomingIds = new Set(msgs.map((m: Message) => m._id));
    const newerLocal = existing.filter(
      (m: Message) => m.timestamp > incomingNewestTs && !incomingIds.has(m._id)
    );
    const merged = newerLocal.length > 0 ? [...msgs, ...newerLocal] : msgs;
    this.messages[convId] = merged;
    const pag = { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...meta };
    this.pagination[convId] = pag;
    writeConversationMessages(convId, merged, pag);
    evictInactiveMessages(this, convId);
  }),

  // The live-tail apply. listMessagesTail's result is AUTHORITATIVE for the
  // range (anchorTs, lastTimestamp]: local rows there are replaced wholesale.
  // This is what delivers in-place streaming patches — mergeMessages is
  // add-only and silently drops a row whose _id already exists — and in-range
  // deletes (API-error banner supersession). Rows at or before the anchor stay
  // untouched; rows strictly newer than the tail's last timestamp are
  // preserved (a recovery fetch can race ahead of the subscription). An empty
  // tail result changes nothing: deletes of old rows reconcile through the
  // message-count watermark refetch, never through an empty window.
  applyTailMessages: sync(function (this: Draft, convId: string, anchorTs: number, msgs: Message[], lastTimestamp: number | null) {
    msgs = dedupeReplayedMessages(msgs);
    if (msgs.length === 0) return;
    prunePendingEchoes(this, convId, msgs);
    const existing = this.messages[convId] || [];
    const tailLast = lastTimestamp ?? msgs[msgs.length - 1].timestamp;
    const incomingIds = new Set(msgs.map((m: Message) => m._id));
    const keep = existing.filter((m: Message) => m.timestamp <= anchorTs && !incomingIds.has(m._id));
    const newerLocal = existing.filter((m: Message) => m.timestamp > tailLast && !incomingIds.has(m._id));
    const merged = [...keep, ...msgs, ...newerLocal];
    // A stale in-flight result from a just-replaced anchor can interleave with
    // kept rows; the feed assumes ascending order, so sort unconditionally.
    merged.sort((a: Message, b: Message) => a.timestamp - b.timestamp);
    this.messages[convId] = merged;
    const pag = { ...(this.pagination[convId] || DEFAULT_PAGINATION), initialized: true };
    this.pagination[convId] = pag;
    writeConversationMessages(convId, merged, pag);
    evictInactiveMessages(this, convId);
  }),

  mergeMessages: sync(function (this: Draft, convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) {
    msgs = dedupeReplayedMessages(msgs);
    const existing = this.messages[convId] || [];
    const existingIds = new Set(existing.map((m: Message) => m._id));
    const existingReplayKeys = new Set(existing.map(messageReplayKey).filter((key): key is string => !!key));
    const unique = msgs.filter((m: Message) => {
      if (existingIds.has(m._id)) return false;
      const key = messageReplayKey(m);
      return !key || !existingReplayKeys.has(key);
    });
    if (unique.length === 0 && !meta) return;

    const merged = direction === "prepend"
      ? [...unique, ...existing]
      : [...existing, ...unique];
    merged.sort((a: Message, b: Message) => a.timestamp - b.timestamp);
    // Server data only — pending messages are merged at read time
    this.messages[convId] = merged;
    const pag = meta ? { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...meta } : this.pagination[convId];
    if (meta) this.pagination[convId] = pag;
    writeConversationMessages(convId, merged, pag);
    evictInactiveMessages(this, convId);
  }),

  setUserMessages: sync(function (this: Draft, convId: string, msgs: UserMessage[]) {
    const prev = this.userMessages[convId];
    // Convex hands back a fresh array on every reactive tick. Bail when the
    // snapshot is unchanged (same length + edge ids) so consumers don't
    // re-render on no-op updates — mirrors the messages-sync dedup.
    if (prev && prev.length === msgs.length &&
        prev[0]?._id === msgs[0]?._id &&
        prev[prev.length - 1]?._id === msgs[msgs.length - 1]?._id) {
      return;
    }
    this.userMessages[convId] = msgs;
    // Persisted beside the message pages so a reopen (or a reload) paints the
    // message navigator from disk instead of a skeleton while getUserMessages
    // is in flight; ensureHydrated restores it.
    writeConversationUserMessages(convId, msgs);
  }),

  addOptimisticMessage: sync(function (this: Draft, convId: string, content: string, images?: Array<OptimisticImage>, clientId?: string) {
    // A caller-supplied clientId lets a DIFFERENT window (the compose popup) seed
    // an optimistic bubble in this window that still dedupes against the server
    // echo of the send the popup already dispatched — the echo's client_id matches
    // this _clientId. Idempotent on that id so a re-delivered cross-window
    // broadcast (or a racing server echo) can't double-insert.
    const id = clientId ?? `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (clientId && this.pendingMessages[convId]?.some((m) => m._clientId === clientId)) return id;
    const msg: Message = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      _clientId: id,
      // Snapshot the conversation's current server updated_at so the absence-prune
      // can later tell "server has processed my send" from "stale pre-send snapshot."
      _sentBaselineTs: this.sessions[convId]?.updated_at,
      ...(images && images.length > 0 ? { images } : {}),
    };
    if (!this.pendingMessages[convId]) this.pendingMessages[convId] = [];
    this.pendingMessages[convId].push(msg);
    return id;
  }),

  markOptimisticAsQueued: sync(function (this: Draft, convId: string, content: string) {
    const stripped = stripImageRef(content);
    const promote = (m: Message) => {
      if (m._isOptimistic && m.role === "user" && stripImageRef(m.content || "") === stripped) {
        const { _isOptimistic, ...rest } = m;
        return { ...rest, _isQueued: true as const };
      }
      return m;
    };
    const pending = this.pendingMessages[convId];
    if (pending) {
      this.pendingMessages[convId] = pending.map(promote);
    }
  }),

  markOptimisticAsFailed: sync(function (this: Draft, convId: string, clientId: string) {
    const mark = (m: Message): Message => {
      if (m._clientId === clientId || m._id === clientId) {
        return { ...m, _isFailed: true as const };
      }
      return m;
    };
    const pending = this.pendingMessages[convId];
    if (pending) {
      this.pendingMessages[convId] = pending.map(mark);
    }
  }),

  // The revert half of addOptimisticMessage: drop a bubble whose delivery was
  // refused before it ever reached the rail (the blocked-revive paint, whose
  // mutation threw). Marking it failed would keep it forever — the prune
  // deliberately protects failed sends for a retry — so a gesture that will
  // never be delivered has to take its optimistic copy back with it.
  removeOptimisticMessage: sync(function (this: Draft, convId: string, clientId: string) {
    const pending = this.pendingMessages[convId];
    if (!pending) return;
    const kept = pending.filter((m) => m._clientId !== clientId && m._id !== clientId);
    if (kept.length === pending.length) return;
    if (kept.length === 0) delete this.pendingMessages[convId];
    else this.pendingMessages[convId] = kept;
  }),

  // Lands settled uploads on the row by client id, under whichever key holds it
  // now: the upload task captured the STUB id at send time, and a parked create
  // may have rekeyed the row to its real id while the upload was in flight. A
  // miss would leave the row `uploading` forever and every redrive would skip it.
  resolvePendingUploads: sync(function (this: Draft, convId: string, clientId: string, images: Array<OptimisticImage>) {
    const isRow = (m: Message) => m._clientId === clientId || m._id === clientId;
    const keys = this.pendingMessages[convId]?.some(isRow)
      ? [convId]
      : Object.keys(this.pendingMessages).filter((key) => this.pendingMessages[key]?.some(isRow));
    for (const key of keys) {
      this.pendingMessages[key] = this.pendingMessages[key].map((m) => (isRow(m) ? { ...m, images } : m));
    }
  }),

  stampPendingDispatchContent: sync(function (this: Draft, convId: string, clientId: string, dispatchContent: string) {
    const pending = this.pendingMessages[convId];
    if (!pending) return;
    this.pendingMessages[convId] = pending.map((m) =>
      m._clientId === clientId || m._id === clientId ? { ...m, _dispatchContent: dispatchContent } : m
    );
  }),

  setPagination: action(function (this: Draft, convId: string, update: Partial<PaginationState>) {
    this.pagination = {
      ...this.pagination,
      [convId]: { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...update },
    };
  }),

  initPagination: action(function (this: Draft, convId: string) {
    if (this.pagination[convId]) return;
    this.pagination = { ...this.pagination, [convId]: { ...DEFAULT_PAGINATION } };
  }),

  // =====================
  // METADATA
  // =====================

  setCurrentConversation: action(function (this: Draft, ctx: CurrentConversationContext) {
    this.currentConversation = ctx;
  }),

  setIsolatedWorktreeMode: action(function (this: Draft, val: boolean) {
    this.isolatedWorktreeMode = val;
  }),

  clearCurrentConversation: action(function (this: Draft) {
    this.currentConversation = {};
  }),

  // =====================
  // DRAFTS
  // =====================

  setDraft: sync(function (this: Draft, id: string, fields: Record<string, any>) {
    this.drafts[id] = fields;
    if (!this.clientState.drafts) this.clientState.drafts = {};
    this.clientState.drafts[id] = fields;
  }),

  getDraft: (id: string) => {
    return get().drafts[id];
  },

  // Kept-draft marker on the session ROW (see InboxSession._hasDraft). sync():
  // local + IDB only — a deferred stub has no server row to dispatch to.
  setSessionHasDraft: sync(function (this: Draft, id: string, has: boolean) {
    const row = this.sessions[id];
    if (!row) return;
    if (has) row._hasDraft = true;
    else delete row._hasDraft;
  }),

  moveDraft: sync(function (this: Draft, fromId: string, toId: string) {
    if (fromId === toId) return;
    const draft = this.drafts[fromId]
      ?? (this.clientState.drafts?.[fromId] && typeof this.clientState.drafts[fromId] === "object"
        ? this.clientState.drafts[fromId] as Record<string, any>
        : undefined);
    if (!draft) return;
    this.drafts[toId] = draft;
    delete this.drafts[fromId];
    if (!this.clientState.drafts) this.clientState.drafts = {};
    this.clientState.drafts[toId] = draft;
    this.clientState.drafts[fromId] = null;
  }),

  clearDraft: sync(function (this: Draft, id: string) {
    delete this.drafts[id];
    if (!this.clientState.drafts) this.clientState.drafts = {};
    this.clientState.drafts[id] = null;
    // A kept-draft row's whole reason to exist is its draft — clearing the
    // draft (sent or discarded) retires the marker with it.
    if (this.sessions[id]?._hasDraft) delete this.sessions[id]._hasDraft;
  }),

  clearDraftFinal: action(function (this: Draft, id: string) {
    delete this.drafts[id];
    if (!this.clientState.drafts) this.clientState.drafts = {};
    this.clientState.drafts[id] = null;
    if (this.sessions[id]?._hasDraft) delete this.sessions[id]._hasDraft;
    // The conversation row is a second durable home for the draft (mobile
    // persists straight to conversations.draft_message, and the composer seeds
    // from it via initialDraft). A final clear that leaves it standing lets
    // the row re-seed the composer on the next boot. Only real Convex ids —
    // compose stubs and comment keys have no server row to clear.
    if (/^[a-z0-9]{32}$/.test(id)) {
      if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
      (this.conversations[id] as any).draft_message = null;
    }
  }),

  // =====================
  // QUEUED MESSAGES
  // =====================
  // The texts a user queued (Ctrl+Enter) while the agent was busy, waiting to
  // auto-send when it next reaches "needs input". Local-first like drafts:
  // sync() writes the IDB-persisted record (no server dispatch), so they
  // survive navigation and reload. The drain that actually sends them lives in
  // MessageInput's idle watcher.

  getQueuedMessages: (id: string) => {
    return get().queuedMessages[id] ?? [];
  },

  setQueuedMessagesFor: sync(function (this: Draft, id: string, list: string[]) {
    if (!list || list.length === 0) {
      delete this.queuedMessages[id];
    } else {
      this.queuedMessages[id] = list;
    }
  }),

  // =====================
  // SESSION ID RESOLUTION
  // =====================

  _rekeySession: sync(function (this: Draft, sessionId: string, convexId: string) {
    rekeyPending(this.pending, sessionId, convexId);
    rekeyId(this, sessionId, convexId);
  }),

  resolveSessionId: (sessionId: string, convexId: string) => {
    const launchReconfigure = pendingLaunchReconfigure(
      get().sessions[sessionId] || get().conversations[sessionId],
    );
    (get() as any)._rekeySession(sessionId, convexId);
    scheduleResolvedSessionContinuations(convexId, launchReconfigure);
  },

  getConvexId: (id: string) => {
    if (isConvexId(id)) return id;
    const sessions = get().sessions as Record<string, InboxSession>;
    const session = Object.values(sessions).find((s) => s.session_id === id || s._id === id);
    return session && isConvexId(session._id) ? session._id : undefined;
  },

  // Render-safe id resolution across the stub→real rekey. resolveSessionId
  // deletes the stub rows in the same transaction it flips the pointers, but
  // views holding the old id (useDeferredValue, stale props, stub URLs) render
  // at least once more with it. A live row under the id wins; otherwise follow
  // the session_id mapping the stub leaves behind. Falls back to the input so
  // genuinely unknown ids keep their existing not-found behavior.
  resolveLiveSessionId: (id: string) => {
    const s = get();
    if (s.conversations[id] || s.sessions[id]) return id;
    return s.getConvexId(id) ?? id;
  },

  trackSessionCreate: (stubId: string, promise: Promise<string>) => {
    set((s: InboxStoreState) => ({
      pendingSessionCreates: { ...s.pendingSessionCreates, [stubId]: promise },
    }));
    const clearTrackedCreate = () => {
      set((s: InboxStoreState) => {
        if (!s.pendingSessionCreates[stubId]) return s;
        const { [stubId]: _, ...rest } = s.pendingSessionCreates;
        return { pendingSessionCreates: rest };
      });
    };
    // A bare finally() creates a second promise that rejects with the original
    // error. Nobody observes that child, so an honestly parked create still
    // surfaced as an unhandled rejection even when every caller caught `promise`.
    void promise.then(clearTrackedCreate, clearTrackedCreate);
  },

  awaitSessionCreate: (stubId: string) => {
    return get().pendingSessionCreates[stubId];
  },

  awaitConvexId: async (id: string): Promise<string> => {
    const resolved = get().getConvexId(id);
    if (resolved) {
      await awaitResolvedSessionPreparation(resolved);
      return resolved;
    }
    // Prefer the in-flight createSession promise — deterministic and surfaces
    // the real dispatch error if the server rejects. Polling is the fallback
    // for cases where the promise was lost (e.g. reload mid-flight) or the
    // rekey arrives via listInboxSessions altKey sync instead of the dispatch.
    let inFlight = get().awaitSessionCreate(id);
    // SELF-HEAL a stranded stub: no real id and no create in flight means the
    // original createSession was given up (outbox cap) or lost to a reload, so
    // the conversation was never created server-side and the poll below would
    // dead-end at "Session not yet created" forever — the stuck-send symptom.
    // Re-issue the create from the stub's own row; the server is idempotent on
    // (user, session_id), so this revives the original or mints a fresh one and
    // the altKey supersede rekeys the stub either way.
    if (!inFlight && !isConvexId(id) && (get().sessions[id] || get().conversations[id])) {
      inFlight = get().ensureSessionCreated(id);
    }
    let parkedCreateError: unknown = null;
    if (inFlight) {
      let createError: unknown = null;
      try {
        const convexId = await awaitTrackedSessionCreateResult(inFlight);
        if (convexId) {
          await awaitResolvedSessionPreparation(convexId);
          return convexId;
        }
      } catch (e) {
        if (isParkedDispatchError(e)) parkedCreateError = e;
        else createError = e;
      }
      const r2 = get().getConvexId(id);
      if (r2) {
        await awaitResolvedSessionPreparation(r2);
        return r2;
      }
      if (createError) throw createError instanceof Error ? createError : new Error(String(createError));
      // A parked create is already durable and can rekey through the live
      // by_session_id result independently of its rejected in-memory promise.
      // Keep polling below instead of declaring the optimistic first send
      // failed before that resolver has a chance to land.
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const r = get().getConvexId(id);
      if (r) {
        await awaitResolvedSessionPreparation(r);
        return r;
      }
    }
    if (parkedCreateError) throw parkedCreateError;
    throw new Error("Session not yet created on server");
  },

  // Re-create a stub whose original createSession was given up, using the
  // fields the stub row already carries (project/agent ride along so the
  // daemon spawns in the right place). Idempotent against an in-flight create
  // (returns it) and against an already-rekeyed stub (returns the real id).
  // The server dedupes on (user, session_id), so re-issuing is safe even if the
  // original create actually did land — it just resolves to the same row.
  ensureSessionCreated: (id: string): Promise<string> => {
    const s = get();
    const real = s.getConvexId(id);
    if (real && isConvexId(real)) return Promise.resolve(real);
    const existing = s.pendingSessionCreates[id];
    if (existing) return existing;
    const stub = (s.sessions[id] || s.conversations[id]) as any;
    if (!stub || isConvexId(id)) return Promise.resolve(id);
    // A FORK stub must never be revived as a plain create: that silently
    // converts "fork with history" into a blank session that merely inherits
    // the parent's project path — the daemon then spawns a context-less agent
    // and the fork lineage is gone for good. Re-issue forkFromMessage instead;
    // it's idempotent on session_id, so if the original create actually landed
    // this resolves to the existing fork row.
    if (stub.forked_from) {
      const parentId = s.getConvexId(String(stub.forked_from)) ?? String(stub.forked_from);
      if (!isConvexId(parentId)) {
        return Promise.reject(new Error("Fork parent unknown — fork again from the parent thread"));
      }
      const ready = s.convCommand(parentId, "forkFromMessage", {
        ...(stub._forkTargetAgentType
          ? { target_agent_type: stub._forkTargetAgentType }
          : (stub.parent_message_uuid && stub.parent_message_uuid !== "agent-switch"
            ? { message_uuid: stub.parent_message_uuid }
            : {})),
        session_id: id,
      }).then((result: any) => {
        const convexId = result?.conversation_id;
        if (convexId && isConvexId(convexId)) get().resolveForkSessionId(id, convexId);
        return get().getConvexId(id) ?? (isConvexId(convexId) ? convexId : id);
      });
      s.trackSessionCreate(id, ready);
      ready.catch(() => {});
      return ready;
    }
    // Refuse to re-create a PATHLESS stub. The server would create it and ask
    // the daemon to start_session with no cwd, which falls back to spawning in
    // $HOME (daemon start fallback) — an agent running silently outside any
    // checkout, worse than the honest "not created yet" failure this replaces.
    // The rare source is a project-less doc's "new agent" (≈30/6095 docs). The
    // caller (composer) can catch this and route to the project picker; once a
    // path is set (updateSessionProject) the retry re-creates normally. The
    // automatic heal-on-load already filters pathless stubs out, so this only
    // gates the user-triggered awaitConvexId retry.
    if (!stub.project_path && !stub.git_root) {
      return Promise.reject(new Error("Pick a project for this session before sending"));
    }
    // Route through createSessionFromStub (not a bare createSession) so the live
    // project/agent + isolated-worktree mode are sourced identically to the
    // compose popup's materialize — one create-payload builder, two callers.
    const ready = s.createSessionFromStub(id).then((convexId: string) => {
      // createSession returns the server conversation id; rekey explicitly so
      // we don't wait on the listInboxSessions altKey sync. Falls back to the
      // session_id mapping if the dispatch result was empty.
      if (convexId && isConvexId(convexId)) get().resolveSessionId(id, convexId);
      return get().getConvexId(id) ?? (isConvexId(convexId) ? convexId : id);
    });
    s.trackSessionCreate(id, ready);
    ready.catch(() => {});
    return ready;
  },

  // Heal a stranded stub the user TYPED INTO: re-create it, then re-send the
  // messages they queued while it had no server conversation. rekeyId moved
  // pendingMessages[stub] → pendingMessages[real]; sendMessage is durable and
  // dedups on client_id, so replaying is idempotent against any later echo.
  // Image-only messages whose uploads never resolved are skipped (nothing real
  // to send). Returns the real id, or null when the create still hasn't landed
  // (offline/daemon down) — the next sweep retries.
  healStrandedStub: async (stubId: string): Promise<string | null> => {
    let realId: string;
    try {
      realId = await get().ensureSessionCreated(stubId);
    } catch {
      return null;
    }
    if (!isConvexId(realId)) return null;
    const pending = get().pendingMessages[realId] || [];
    for (const m of pending as any[]) {
      // Prefer the recorded dispatch bytes (see redrivePendingMessagesFor) —
      // a row that already sent once must replay identically to dedupe.
      const content = m._dispatchContent || m.content || "";
      const storageIds = (m.images || [])
        .map((im: any) => im.storage_id)
        .filter((sid: any): sid is string => typeof sid === "string");
      if (!content.trim() && storageIds.length === 0) continue;
      get().sendMessage(realId, content, storageIds.length ? storageIds : undefined, m._clientId || m._id);
    }
    return realId;
  },

  redrivePendingMessages: () => {
    for (const convId of Object.keys(get().pendingMessages)) {
      if (isConvexId(convId)) redrivePendingMessagesFor(convId);
    }
  },

  resumePostCreateSessionIntents: () => {
    const state = get();
    const ids = new Set([
      ...Object.keys(state.sessions),
      ...Object.keys(state.conversations),
    ]);
    for (const id of ids) {
      if (isConvexId(id)) resumePostCreateBucketIntentFor(id);
    }
  },

  // =====================
  // FORK NAVIGATION
  // =====================
  // Forks are first-class conversations. The only state we track is the
  // optimistic fork-children list (so the UI can show a freshly created
  // fork before the server confirms its convex id).

  addOptimisticFork: (fork: ForkChild) => {
    set((s: InboxStoreState) => ({
      optimisticForkChildren: [...s.optimisticForkChildren, fork],
    }));
  },

  pruneOptimisticForks: (serverIds: Set<string>) => {
    const current = get().optimisticForkChildren;
    const filtered = current.filter((f: ForkChild) => !serverIds.has(f._id));
    if (filtered.length === current.length) return;
    set({ optimisticForkChildren: filtered });
  },

  resolveForkSessionId: (sessionId: string, convexId: string) => {
    if (sessionId === convexId) return;
    // Full stub→real rekey (sessions, conversations, messages, drafts, pending,
    // currentSessionId, optimistic fork chips, …) — the fork stub is navigated
    // to immediately, so every pointer the new-session stub convention moves
    // must move here too. rekeyId owns the whole set, including
    // optimisticForkChildren (shared with the altKey-supersede path).
    (get() as any)._rekeySession(sessionId, convexId);
  },

  discardForkStub: sync(function (this: Draft, stubId: string, parentId?: string) {
    delete this.sessions[stubId];
    delete this.conversations[stubId];
    delete this.messages[stubId];
    delete this.pendingMessages[stubId];
    delete this.pagination[stubId];
    delete this.drafts[stubId];
    for (const [key, row] of Object.entries(this.bucketAssignments) as Array<[string, BucketAssignmentItem]>) {
      if (row.conversation_id === stubId) delete this.bucketAssignments[key];
    }
    this.optimisticForkChildren = this.optimisticForkChildren.filter((f: ForkChild) => f._id !== stubId);
    if (this.currentSessionId === stubId) {
      // Follow the discarded stub to its parent; with no parent the view goes
      // EMPTY (null), never to some other session — the inbox's adopt fallback
      // is boot-only, so a background discard can't teleport the user.
      declareViewNav("rekey");
      this.currentSessionId = parentId ?? null;
      recordCurrentConversationPointer(this, parentId);
    }
  }),

  // =====================
  // TASK / DOC STATE
  // =====================

  sidebarNavExpanded: {},
  toggleSidebarNav: (section: string) => set((s: any) => ({
    sidebarNavExpanded: { ...s.sidebarNavExpanded, [section]: !s.sidebarNavExpanded[section] },
  })),
  setLiveLoading: (scope: string, loading: boolean) => {
    // No-op guard: the sync hooks re-assert their status on effect re-runs
    // (reconnects, workspace flicker), and each unconditional write was a fresh
    // liveLoading identity waking every subscriber. First write for a scope
    // always lands (the chip lists scopes from these keys).
    const cur = useInboxStore.getState().liveLoading;
    if (scope in cur && cur[scope] === loading) return;
    set((s: any) => ({
      liveLoading: { ...s.liveLoading, [scope]: loading },
    }));
  },

  comments: {},
  tasks: {},
  taskActiveSessions: {} as Record<string, any>,
  taskOriginBadges: {},
  syncProgress: {},
  liveLoading: {},
  mentionIndex: { tasks: {}, docs: {}, plans: {} },
  docs: {},
  plans: {},
  projects: {},
  savedViews: {},
  notifications: {},
  docDetails: {},
  taskFilter: { status: "" },
  docFilter: { type: "", query: "", project: "", scope: "" },
  planFilter: { status: "" },
  docProjectPaths: [],


  setTaskFilter: (filter: Partial<{ status: string }>) => {
    set((s: InboxStoreState) => ({
      taskFilter: { ...s.taskFilter, ...filter },
    }));
  },

  setDocFilter: (filter: Partial<{ type: string; query: string }>) => {
    set((s: InboxStoreState) => ({
      docFilter: { ...s.docFilter, ...filter },
    }));
  },

  setPlanFilter: (filter: Partial<{ status: string }>) => {
    set((s: InboxStoreState) => ({
      planFilter: { ...s.planFilter, ...filter },
    }));
  },

  // The optional resolution rides to dispatch.updateTaskStatus → webUpdate's
  // close-guard; on "cascade" the open local subtree closes optimistically too.
  // Both writers patch EVERY row carrying the short id, not just the first
  // match: the store can hold more than one copy of a task (a detail-query row
  // keyed by URL param in pre-fix sessions, a stub beside its echo), and
  // patching one copy leaves whichever copy a view happens to render frozen at
  // the old status while the detail shows the new one.
  updateTaskStatus: action(function (this: Draft, shortId: string, status: string, subtaskResolution?: "cascade" | "only_parent") {
    const copies = Object.values(this.tasks).filter((t: any) => t.short_id === shortId) as TaskItem[];
    for (const task of copies) {
      // Category change orphans a custom-status refinement (server rule in
      // tasks.resolveStatusWrite); mirror it so the row re-renders honestly.
      if (status !== task.status) (task as any).status_id = undefined;
      task.status = status;
      task.updated_at = Date.now();
      if (status === "done" || status === "dropped") (task as any).closed_at = Date.now();
    }
    if ((status === "done" || status === "dropped") && subtaskResolution === "cascade") {
      for (const id of new Set(copies.map((t) => String(t._id)))) cascadeCloseDraft(this, id, status);
    }
  }),

  updateTask: action(function (this: Draft, shortId: string, fields: Record<string, any>) {
    const copies = Object.values(this.tasks).filter((t: any) => t.short_id === shortId) as TaskItem[];
    // `parent` is a short id (or "" to detach) for the server; the draft
    // mirrors it onto parent_id so the row re-nests instantly. The caller
    // (setTaskParent) has already run the shared cycle/workspace guards.
    const { parent, subtask_resolution, ...rest } = fields;
    const parentRow = parent
      ? (Object.values(this.tasks).find((t: any) => t.short_id === parent || t._id === parent) as TaskItem | undefined)
      : undefined;
    // Mirror the server's custom-status rules (tasks.resolveStatusWrite):
    // "" clears the refinement, and a category change without an explicit
    // refinement clears the stale one — else the row would keep rendering
    // the old category's custom status until the echo. The "" decision is
    // hoisted so deleting it from `rest` for the first copy can't hide it
    // from the rest.
    const clearStatusId = rest.status_id === "";
    if (clearStatusId) delete rest.status_id;
    for (const task of copies) {
      if (clearStatusId || (rest.status && rest.status !== (task as any).status && rest.status_id === undefined)) {
        (task as any).status_id = undefined;
      }
      Object.assign(task, rest, { updated_at: Date.now() });
      if (parent !== undefined) {
        if (!parent) (task as any).parent_id = undefined;
        else if (parentRow) (task as any).parent_id = parentRow._id;
      }
    }
    if ((fields.status === "done" || fields.status === "dropped") && subtask_resolution === "cascade") {
      for (const id of new Set(copies.map((t) => String(t._id)))) cascadeCloseDraft(this, id, fields.status);
    }
    // Assigning to another PERSON is a handoff (the server mutes the assigner
    // and drops their thread_reads row): mirror it so the task's card leaves
    // this Threads inbox now, not on the next sync. Agent labels hand the
    // stream to nobody, so the follow stays. The exclude tombstone stops a
    // racing listMine push from re-adding the row.
    const me = this.currentUser?._id ? String(this.currentUser._id) : undefined;
    if (rest.assignee && me && String(rest.assignee) !== me && !String(rest.assignee).startsWith("agent:")) {
      for (const id of new Set(copies.map((t) => String(t._id)))) {
        const rowId = `task:${id}`;
        const row = this.threadInbox[rowId];
        if (!row) continue;
        if (row.unread > 0 && this.threadUnread > 0) this.threadUnread -= 1;
        delete this.threadInbox[rowId];
        this.pending[`threadInbox:${rowId}`] = { type: "exclude", ts: Date.now() };
      }
    }
  }),

  // Plans are a protected store collection with no serverTable, so the local
  // mutation here is field-protected but only the updatePlan side-effect writes
  // to Convex (it delegates to plans.webUpdate for progress recalc + doc sync).
  // Keyed by short_id to match the server mutation and the picker call sites.
  updatePlan: action(function (this: Draft, shortId: string, fields: Record<string, any>) {
    const plan = Object.values(this.plans).find((p: any) => p.short_id === shortId || p._id === shortId) as any;
    if (plan) Object.assign(plan, fields, { updated_at: Date.now() });
  }),

  updateProject: action(function (this: Draft, id: string, fields: Record<string, any>) {
    const project = (this.projects as any)[id] ?? Object.values(this.projects).find((p: any) => p._id === id);
    if (project) Object.assign(project, fields, { updated_at: Date.now() });
  }),

  // Local-first create: an optimistic stub renders the row instantly (the
  // quick-add loop on task detail fires several per second). The stub carries a
  // minted client_key and is keyed by `temp_task_<key>`; when the server row
  // syncs back with the same client_key, the tasks altKey supersede rekeys the
  // stub onto the real _id and prunes it (SYNC_REGISTRY.tasks). The dispatch
  // forwards client_key to the idempotent webCreate, so a retry can't double
  // the server row. opts.client_key is always set by callers (createTaskAndAdopt);
  // a fallback keeps a bare call safe.
  createTask: asyncAction(function (this: Draft, opts: any) {
    if (!opts.client_key) opts.client_key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tempId = `temp_task_${opts.client_key}`;
    // A subtask stub inherits its parent's containers so it renders in place
    // (same group, same board scope) instead of jumping on the server echo.
    const parentRow = opts.parent
      ? (Object.values(this.tasks).find((t: any) => t.short_id === opts.parent || t._id === opts.parent) as TaskItem | undefined)
      : undefined;
    this.tasks[tempId] = {
      _id: tempId,
      client_key: opts.client_key,
      short_id: "ct-…",
      title: opts.title,
      description: opts.description,
      task_type: opts.task_type || "task",
      status: opts.status || "open",
      priority: opts.priority || "medium",
      source: "human",
      labels: opts.labels,
      assignee: opts.assignee,
      parent_id: parentRow?._id ?? undefined,
      plan_id: opts.plan_id ?? (parentRow as any)?.plan_id,
      project_id: opts.project_id ?? (parentRow as any)?.project_id,
      team_id: opts.team_id ?? parentRow?.team_id,
      created_at: Date.now(),
      updated_at: Date.now(),
    } as any as TaskItem;
  }),

  // Remove a create-stub whose server create was permanently refused (depth
  // cap, workspace/plan access) — no server row will ever sync back to
  // supersede it, so without this the stub strands as a durable ghost. Plants
  // the exclude tombstone so the IDB diff is authorised to delete the row.
  // One-time repair. A short-lived build pruned savedViews with
  // pruneAbsentScope, which writes a DURABLE exclude tombstone for every row
  // absent from a push — and webList is legitimately empty for a beat while auth
  // settles. Any client that ran it has views permanently hidden from its own
  // rail while they sit healthy on the server. Nothing else ever tombstones this
  // table (it syncs as a plain replace), so clearing them all is safe and this
  // becomes a no-op for everyone else.
  clearSavedViewTombstones: sync(function (this: Draft) {
    for (const key of Object.keys(this.pending)) {
      if (key.startsWith("savedViews:")) delete (this.pending as any)[key];
    }
  }),

  removeTaskStub: sync(function (this: Draft, clientKey: string) {
    const tempId = `temp_task_${clientKey}`;
    if (!this.tasks[tempId]) return;
    delete this.tasks[tempId];
    delete (this.pending as any)[`tasks:${tempId}`];
    (this.pending as any)[`tasks:${tempId}`] = { type: "exclude", ts: Date.now() };
  }),

  // Creates route through the single dispatch path (no direct useMutation) and
  // delegate to the existing webCreate mutation, which returns the real id. We
  // intentionally do NOT add an optimistic stub: every caller awaits the result
  // and navigates to the new record's own page, and delta-synced lists don't
  // prune, so a temp stub would linger as a duplicate. receiptAsyncAction keeps
  // its Promise pending across an unwired window and resolves it from the exact
  // durable command receipt, preserving the caller's navigation continuation.
  createDoc: receiptAsyncAction(function (
    this: Draft,
    _opts: Record<string, any>,
    continuation?: DurableCreateContinuation,
  ) {
    return continuation ? { continuation } : undefined;
  }),
  createPlan: receiptAsyncAction(function (
    this: Draft,
    _opts: Record<string, any>,
    continuation?: DurableCreateContinuation,
  ) {
    return continuation ? { continuation } : undefined;
  }),
  createProject: receiptAsyncAction(function (
    this: Draft,
    _opts: Record<string, any>,
    continuation?: DurableCreateContinuation,
  ) {
    return continuation ? { continuation } : undefined;
  }),
  // Low-frequency doc/plan/conversation ops: route through dispatch and delegate
  // to the existing mutations. asyncAction surfaces the server result for the
  // callers that navigate to / read the returned record.
  promoteDocToPlan: asyncAction(function (this: Draft, _docId: string) {}),
  ensurePlanDoc: asyncAction(function (this: Draft, _planShortId: string) {}),
  publishToDirectory: asyncAction(function (this: Draft, _opts: Record<string, any>) {}),

  // -- Manual session buckets --
  // Local-first create: a stub chip appears instantly (keyed by a non-Convex
  // id, so the patch path skips it and the dispatch args carry the create);
  // when the server row syncs back, the buckets altKey ("name") supersedes the
  // stub — same machinery as bucketAssignments' stubs. Callers still await the
  // returned REAL _id for follow-up assignment.
  createBucket: receiptAsyncAction(function (
    this: Draft,
    opts: { name: string; color?: string },
    continuation?: DurableCreateContinuation,
  ) {
    const name = (opts?.name || "").trim();
    if (!name) return;
    const stubId = `bucketstub-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    // Mirror the server's append-to-end stamp so the stub lands where the real
    // row will (the server's own max+1024 wins after supersede).
    const maxOrder = (Object.values(this.buckets) as BucketItem[])
      .reduce((m, b) => Math.max(m, b.sort_order ?? 0), 0);
    this.buckets[stubId] = {
      _id: stubId,
      name,
      sort_order: maxOrder + 1024,
      ...(opts.color ? { color: opts.color } : {}),
      created_at: now,
      updated_at: now,
    };
    return { stubId, ...(continuation ? { continuation } : {}) };
  }),

  // -- Teams --
  // Local-first create, the same shape as createBucket: the stub row and the
  // workspace switch happen in one draft, so the switcher and the sidebar show
  // the new team in the same tick. The server mutation (teams.createTeam)
  // writes the canonical users.active_team_id, and the dispatch handler writes
  // the ui mirror with the real id, so both halves agree once the echo lands
  // (see lib/__tests__/activeTeamPointer.guard.test.ts). The `teams` list is
  // replaced wholesale on echo, which retires the stub; resolveTeamStub rekeys
  // it first so a caller holding the real id never sees a gap.
  createTeam: async (opts: { name: string; icon?: string; icon_color?: string }) => {
    const name = (opts?.name || "").trim();
    if (!name) throw new Error("Team name is required");
    const stubId = `team-stub-${Math.random().toString(36).slice(2)}`;
    const previousActiveTeamId = get().clientState.ui?.active_team_id;
    try {
      const teamId = await get().dispatchCreateTeam(stubId, { ...opts, name });
      if (typeof teamId !== "string" || !teamId) throw new Error("Team create returned no id");
      get().resolveTeamStub(stubId, teamId);
      return teamId;
    } catch (error) {
      get().discardTeamStub(stubId, previousActiveTeamId);
      throw error;
    }
  },

  dispatchCreateTeam: asyncAction(function (this: Draft, stubId: string, opts: { name: string; icon?: string; icon_color?: string }) {
    this.teams = [
      ...(this.teams ?? []),
      {
        _id: stubId,
        name: opts.name,
        icon: opts.icon,
        icon_color: opts.icon_color,
        role: "admin",
        memberCount: 1,
        created_at: Date.now(),
      },
    ];
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    this.clientState.ui.active_team_id = stubId;
  }),

  resolveTeamStub: sync(function (this: Draft, stubId: string, teamId: string) {
    this.teams = (this.teams ?? []).map((t: any) => (t?._id === stubId ? { ...t, _id: teamId } : t));
    if (this.clientState.ui?.active_team_id === stubId) this.clientState.ui.active_team_id = teamId;
  }),

  discardTeamStub: sync(function (this: Draft, stubId: string, previousActiveTeamId: string | undefined) {
    this.teams = (this.teams ?? []).filter((t: any) => t?._id !== stubId);
    if (this.clientState.ui?.active_team_id === stubId) this.clientState.ui.active_team_id = previousActiveTeamId;
  }),

  // Rename / color / sort / archive ride the generic patch path (inbox_buckets
  // is in dispatch TABLE_CONFIG); fields are auto-protected until server echo.
  updateBucket: action(function (this: Draft, id: string, fields: { name?: string; color?: string; sort_order?: number; archived_at?: number | null }) {
    const bucket = this.buckets[id] as any;
    if (!bucket) return;
    const previous: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      previous[k] = bucket[k];
      bucket[k] = v === null ? undefined : v;
    }
    bucket.updated_at = Date.now();
    return { bucketId: id, fields, previous };
  }),

  // Exclusive filing: upsert the one assignment row for this conversation.
  // First-time assignments add a stub row; the bucketAssignments altKey config
  // rekeys it onto the server row when it syncs. The same-named dispatch side
  // effect performs the durable upsert. A stub conversation id is allowed when
  // the server reaches the same assignment on its own (fork label inheritance):
  // the dispatch no-ops there, and rekeyId carries the local row to the real id.
  assignSessionToBucket: action(function (this: Draft, conversationId: string, bucketId: string | null) {
    const now = Date.now();
    // A create-time focused-bucket marker is only a fallback until the first
    // authoritative filing. A later explicit move/unfile is newer user intent
    // and must survive reload; clear the old marker in the same local commit.
    // Assigning the marker's own bucket keeps it until server echo, preserving
    // crash-after-enqueue recovery for the automatic filing.
    const clearSupersededIntent = (row: any) => {
      if (
        row?._postCreateBucketId &&
        row._postCreateBucketId !== bucketId
      ) {
        delete row._postCreateBucketId;
      }
    };
    clearSupersededIntent(this.sessions[conversationId]);
    clearSupersededIntent(this.conversations[conversationId]);
    const existing = (Object.values(this.bucketAssignments) as BucketAssignmentItem[])
      .find(a => a.conversation_id === conversationId);
    const previous = existing
      ? {
          rowId: String(existing._id),
          bucketId: existing.bucket_id ?? null,
          updatedAt: existing.updated_at,
        }
      : null;
    if (existing) {
      existing.bucket_id = bucketId ?? undefined;
      existing.updated_at = now;
    } else {
      const stubId = `bucketassign-${conversationId}`;
      this.bucketAssignments[stubId] = {
        _id: stubId,
        conversation_id: conversationId,
        bucket_id: bucketId ?? undefined,
        updated_at: now,
      };
    }
    return {
      conversationId,
      bucketId,
      previous,
      optimisticRowId: String(existing?._id ?? `bucketassign-${conversationId}`),
    };
  }),

  // -- Teammate comments --
  // Optimistic stub keyed by a client_id; the synced server row supersedes it via
  // the comments altKey config, and the server dedups on client_id so an outbox
  // retry can't double-insert. The same-named dispatch side effect does the
  // durable write (notifications, mentions, github sync) via comments.addComment.
  addComment: receiptAsyncAction(function (this: Draft, conversationId: string, content: string, opts?: { messageId?: string; parentCommentId?: string; filePath?: string; lineNumber?: number }) {
    const body = content.trim();
    if (!body) return;
    const clientId = `commentstub-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const me = (this as any).currentUser;
    this.comments[clientId] = {
      _id: clientId,
      client_id: clientId,
      conversation_id: conversationId,
      message_id: opts?.messageId,
      parent_comment_id: opts?.parentCommentId,
      file_path: opts?.filePath,
      line_number: opts?.lineNumber,
      content: body,
      user_id: me?._id ?? "",
      created_at: Date.now(),
      author_kind: "user",
      user: me ? { _id: me._id, name: me.name, github_username: me.github_username, github_avatar_url: me.github_avatar_url, image: me.image } : null,
    } as CommentRow;
    return {
      conversationId,
      content: body,
      messageId: opts?.messageId,
      parentCommentId: opts?.parentCommentId,
      filePath: opts?.filePath,
      lineNumber: opts?.lineNumber,
      clientId,
      commandId: `legacy-comments-create:${clientId}`,
    };
  }),

  // Receipt-backed because a generic patch can be acknowledged as a no-op when
  // the cached comment was deleted or access was revoked. Preserve the exact
  // prior content so a terminal V2 rejection can release pending protection
  // and restore what the user saw before this edit.
  editComment: receiptAsyncAction(function (this: Draft, commentId: string, content: string) {
    const c = this.comments[commentId] as any;
    const previousContent = typeof c?.content === "string" ? c.content : "";
    const conversationId = typeof c?.conversation_id === "string"
      ? c.conversation_id
      : undefined;
    const clientId = typeof c?.client_id === "string" ? c.client_id : undefined;
    if (c) c.content = content;
    return {
      ...(isConvexId(commentId) ? { commentId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(clientId ? { clientId } : {}),
      content,
      previousContent,
      // Only used if an envelope-era payload is replayed by an older bridge.
      // The receipt envelope's random command id is canonical for new writes.
      commandId: `legacy-comments-update:${clientId || commentId}:${Date.now()}`,
    };
  }),

  deleteComment: receiptAsyncAction(function (this: Draft, commentId: string) {
    const comment = this.comments[commentId] as any;
    // Values read from a mutative draft are revocable proxies. The action
    // result is persisted and serialized after the recipe closes, so capture a
    // plain snapshot while the proxy is still live.
    const optimisticComment = comment
      ? JSON.parse(JSON.stringify(comment)) as CommentRow
      : undefined;
    delete this.comments[commentId];
    const clientId = comment?.client_id as string | undefined;
    return {
      ...(isConvexId(commentId) ? { commentId } : {}),
      ...(comment?.conversation_id ? { conversationId: String(comment.conversation_id) } : {}),
      ...(clientId ? { clientId } : {}),
      ...(optimisticComment ? { optimisticComment } : {}),
      commandId: `legacy-comments-delete:${clientId || commentId}`,
    };
  }),

  // Resolve/reopen one comment thread. Stamps (or clears) resolved_at on every
  // cached comment sharing the anchor — mirroring the server, which does the
  // same to the authoritative rows; the live echo reconciles. Idempotent, so
  // the plain dispatch path (no receipt) is enough.
  resolveCommentThread: action(function (this: Draft, conversationId: string, anchor: { messageId?: string; filePath?: string; lineNumber?: number }, resolved: boolean) {
    const me = (this as any).currentUser;
    const now = Date.now();
    for (const comment of Object.values(this.comments) as CommentRow[]) {
      if (comment.conversation_id !== conversationId) continue;
      const inThread = anchor.messageId
        ? comment.message_id === anchor.messageId
        : anchor.filePath
          ? !comment.message_id && comment.file_path === anchor.filePath && comment.line_number === anchor.lineNumber
          : !comment.message_id && !comment.file_path;
      if (!inThread) continue;
      comment.resolved_at = resolved ? now : undefined;
      comment.resolved_by = resolved ? me?._id : undefined;
    }
  }),

  // Opt-in agent reply: drop an optimistic "thinking" agent comment so the UI
  // reacts instantly; the side effect spawns/reuses the thread's fork.
  askAgentInThread: receiptAsyncAction(function (this: Draft, conversationId: string, opts?: { messageId?: string; filePath?: string; lineNumber?: number }) {
    const clientId = `commentstub-agent-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const me = (this as any).currentUser;
    this.comments[clientId] = {
      _id: clientId,
      client_id: clientId,
      conversation_id: conversationId,
      message_id: opts?.messageId,
      file_path: opts?.filePath,
      line_number: opts?.lineNumber,
      content: "",
      user_id: me?._id ?? "",
      created_at: Date.now(),
      author_kind: "agent",
      agent_status: "thinking",
    } as CommentRow;
    return {
      conversationId,
      messageId: opts?.messageId,
      filePath: opts?.filePath,
      lineNumber: opts?.lineNumber,
      clientId,
      commandId: `legacy-comments-ask:${clientId}`,
    };
  }),

  _handleReceiptAcknowledgement: sync(function (
    this: Draft,
    actionName: string,
    continuation: DurableCreateContinuation,
    serverResult: any,
    _commandId: string,
  ) {
    const seedTarget = { createDoc: "docs", createPlan: "plans", createProject: "projects" } as const;
    if (actionName in seedTarget) {
      // The receipt carries the inserted row. Seed the collection so the detail
      // page (which paints from the store) has its row before the view moves;
      // the list feed's echo reconciles the same key.
      const row = serverResult?.row;
      const collection = (this as any)[seedTarget[actionName as keyof typeof seedTarget]];
      if (continuation.kind === "navigate" && row && typeof row._id === "string" && collection && !collection[row._id]) {
        collection[row._id] = row;
      }
      return;
    }
    if (
      actionName !== "createBucket" ||
      continuation.kind !== "assignBucket" ||
      typeof serverResult?.bucketId !== "string"
    ) {
      return;
    }

    // The server applies this filing in the same transaction as the create
    // receipt. Mirror that acknowledged state locally without dispatching a
    // second command. Replaying after a crash updates the same per-conversation
    // row, so effect-before-outbox-cleanup stays idempotent.
    for (const conversationId of continuation.conversationIds) {
      if (!isConvexId(conversationId)) continue;
      const existing = (Object.values(this.bucketAssignments) as BucketAssignmentItem[])
        .find((row) => row.conversation_id === conversationId);
      if (existing) {
        existing.bucket_id = serverResult.bucketId;
        existing.updated_at = Date.now();
      } else {
        const stubId = `bucketassign-${conversationId}`;
        this.bucketAssignments[stubId] = {
          _id: stubId,
          conversation_id: conversationId,
          bucket_id: serverResult.bucketId,
          updated_at: Date.now(),
        };
      }
    }
  }),

  // Receipt-backed actions return rejections as data, not thrown Convex
  // failures. The middleware invokes this local-only reducer for both a live
  // response and a boot-time replay, so an optimistic row cannot remain
  // protected after the server durably refused its command.
  _handleReceiptRejection: sync(function (
    this: Draft,
    actionName: string,
    localResult: any,
  ) {
    if (!localResult || typeof localResult !== "object") return false;

    if (actionName === "createBucket") {
      const stubId = localResult.stubId;
      if (typeof stubId !== "string") return false;
      delete this.buckets[stubId];
      delete this.pending[`buckets:${stubId}`];
      return ["buckets", "pending"];
    }

    if (actionName === "updateBucket") {
      const bucketId = localResult.bucketId;
      const fields = localResult.fields;
      const previous = localResult.previous;
      const bucket = typeof bucketId === "string" ? this.buckets[bucketId] as any : null;
      if (!bucket || !fields || !previous) return false;
      for (const [field, optimisticValue] of Object.entries(fields)) {
        const normalizedOptimistic = optimisticValue === null ? undefined : optimisticValue;
        // A later edit wins; rollback only the exact rejected value.
        if (bucket[field] !== normalizedOptimistic) continue;
        const prior = previous[field];
        if (prior === undefined) delete bucket[field];
        else bucket[field] = prior;
        delete this.pending[`buckets:${bucketId}:${field}`];
      }
      return ["buckets", "pending"];
    }

    if (actionName === "assignSessionToBucket") {
      const conversationId = localResult.conversationId;
      const requestedBucketId = localResult.bucketId ?? null;
      const optimisticRowId = localResult.optimisticRowId;
      if (typeof conversationId !== "string" || typeof optimisticRowId !== "string") {
        return false;
      }
      const found = Object.entries(this.bucketAssignments).find(([, row]) =>
        (row as any)?.conversation_id === conversationId);
      const current = found?.[1] as any;
      if ((current?.bucket_id ?? null) !== requestedBucketId) {
        return ["bucketAssignments", "pending"];
      }
      const previous = localResult.previous;
      if (previous && typeof previous.rowId === "string") {
        const rowId = found?.[0] ?? previous.rowId;
        if (current) {
          current.bucket_id = previous.bucketId ?? undefined;
          current.updated_at = previous.updatedAt;
        }
        delete this.pending[`bucketAssignments:${rowId}:bucket_id`];
      } else if (found) {
        delete this.bucketAssignments[found[0]];
        delete this.pending[`bucketAssignments:${found[0]}`];
      }
      delete this.pending[`bucketAssignments:${optimisticRowId}:bucket_id`];
      return ["bucketAssignments", "pending"];
    }

    if (actionName === "addComment" || actionName === "askAgentInThread") {
      const clientId = localResult.clientId;
      if (typeof clientId !== "string") return false;
      for (const [id, comment] of Object.entries(this.comments)) {
        if (id === clientId || (comment as any)?.client_id === clientId) {
          delete this.comments[id];
          delete this.pending[`comments:${id}`];
        }
      }
      delete this.pending[`comments:${clientId}`];
      return ["comments", "pending"];
    }

    if (actionName === "editComment") {
      const optimisticContent = localResult.content;
      const previousContent = localResult.previousContent;
      const commentId = localResult.commentId;
      const clientId = localResult.clientId;
      if (
        typeof optimisticContent !== "string" ||
        typeof previousContent !== "string"
      ) {
        return false;
      }
      const found = Object.entries(this.comments).find(([id, comment]) =>
        id === commentId ||
        (typeof clientId === "string" &&
          (comment as any)?.client_id === clientId));
      const rowId = found?.[0];
      const comment = found?.[1] as any;

      // A later local edit/delete wins. Only revert the exact optimistic value
      // this rejected receipt introduced, and only release a field lock whose
      // protected value is that same edit.
      if (comment?.content === optimisticContent) {
        comment.content = previousContent;
      }
      const possibleIds = new Set(
        [rowId, commentId, clientId].filter(
          (value): value is string => typeof value === "string",
        ),
      );
      for (const id of possibleIds) {
        const key = `comments:${id}:content`;
        if (this.pending[key]?.value === optimisticContent) {
          delete this.pending[key];
        }
      }
      return ["comments", "pending"];
    }

    if (actionName === "deleteComment") {
      const snapshot = localResult.optimisticComment as CommentRow | undefined;
      const clientId = localResult.clientId as string | undefined;
      const originalId = snapshot?._id || localResult.commentId;
      if (typeof originalId !== "string") return false;
      delete this.pending[`comments:${originalId}`];
      if (clientId) {
        delete this.pending[`comments:${clientId}`];
      }

      // Deleting a just-created stub is a cancellation of that optimistic
      // create. If the create itself was rejected there is nothing to restore;
      // if it succeeded, its real echo (same client_id) is authoritative.
      const existing = clientId
        ? Object.values(this.comments).find(
            (comment: any) => comment?.client_id === clientId,
          )
        : undefined;
      if (
        snapshot &&
        !existing &&
        typeof snapshot._id === "string" &&
        !snapshot._id.startsWith("commentstub")
      ) {
        this.comments[snapshot._id] = snapshot;
      }
      return ["comments", "pending"];
    }

    return false;
  }),

  // Doc drag-reparent: optimistically move the node in the local tree (docs is a
  // protected collection, so parent_id/sort_order are field-protected) and
  // delegate the authoritative write to docs.webMoveDoc.
  moveDoc: asyncAction(function (this: Draft, id: string, parentId?: string, sortOrder?: number) {
    const doc = this.docs[id] as any;
    if (doc) {
      doc.parent_id = parentId;
      if (sortOrder !== undefined) doc.sort_order = sortOrder;
    }
  }),

  addTaskComment: action(function (this: Draft, shortId: string, text: string, commentType?: string, imageIds?: string[]) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as any;
    if (task) {
      // The row may not carry activity yet (list channels never send it) —
      // start the array so the optimistic comment renders instantly; the live
      // detail query reconciles it with the full server set.
      if (!task.comments) task.comments = [];
      task.comments.push({
        _id: `temp_${Date.now()}`,
        author: "You",
        text,
        comment_type: commentType || "note",
        image_storage_ids: imageIds && imageIds.length ? imageIds : undefined,
        created_at: Date.now(),
      });
    }
  }),

  updateDoc: action(function (this: Draft, id: string, fields: { content?: string; title?: string; doc_type?: string; labels?: string[] }) {
    let changed = false;
    if (this.docs[id]) {
      if (fields.content !== undefined && fields.content !== this.docs[id].content) { this.docs[id].content = fields.content; changed = true; }
      if (fields.title !== undefined && fields.title !== this.docs[id].title) { this.docs[id].title = fields.title; changed = true; }
      if (fields.doc_type !== undefined && fields.doc_type !== (this.docs[id] as any).doc_type) { (this.docs[id] as any).doc_type = fields.doc_type; changed = true; }
      if (fields.labels !== undefined) { (this.docs[id] as any).labels = fields.labels; changed = true; }
      if (changed) this.docs[id].updated_at = Date.now();
    }
    if (this.docDetails[id]) {
      if (fields.content !== undefined) this.docDetails[id].content = fields.content;
      if (fields.title !== undefined) this.docDetails[id].title = fields.title;
      if (fields.doc_type !== undefined) (this.docDetails[id] as any).doc_type = fields.doc_type;
      if (fields.labels !== undefined) (this.docDetails[id] as any).labels = fields.labels;
      if (changed) this.docDetails[id].updated_at = Date.now();
    }
  }),

  pinDoc: action(function (this: Draft, id: string, pinned: boolean) {
    if (this.docs[id]) this.docs[id].pinned = pinned;
    if (this.docDetails[id]) (this.docDetails[id] as any).pinned = pinned;
  }),

  archiveDoc: action(function (this: Draft, id: string) {
    delete this.docs[id];
    delete this.docDetails[id];
  }),

  // undoActions restores the exact cached doc snapshots itself. This action is
  // intentionally memory-neutral and exists to make the authoritative unarchive
  // survive reload/offline windows through the outbox.
  restoreArchivedDoc: action(function (_id: string) {}),

  // =====================
  // MESSAGE QUEUE
  // =====================

  sessionsWithQueuedMessages: new Set<string>(),
  blockedReviveRequestedAt: {},
  setSessionHasQueuedMessages: (sessionId: string, hasQueued: boolean) => {
    const prev = get().sessionsWithQueuedMessages;
    // No-op bail: this fires on every queue poll and message push; a fresh Set
    // with the same members woke the inbox panel 16× per session switch.
    if (prev.has(sessionId) === hasQueued) return;
    const next = new Set(prev);
    if (hasQueued) next.add(sessionId);
    else next.delete(sessionId);
    set({ sessionsWithQueuedMessages: next });
  },

  // SIDE PANEL
  // =====================

  shortcutsPanelOpen: false,
  toggleShortcutsPanel: () => set({ shortcutsPanelOpen: !get().shortcutsPanelOpen }),
  anchorPanel: { open: false, anchorId: null },
  openAnchorPanel: (anchorId?: string | null) => set({
    anchorPanel: { open: true, anchorId: anchorId === undefined ? get().anchorPanel.anchorId : anchorId },
  }),
  closeAnchorPanel: () => set({ anchorPanel: { ...get().anchorPanel, open: false } }),
  toggleAnchorPanel: () => set({ anchorPanel: { ...get().anchorPanel, open: !get().anchorPanel.open } }),

  settingsModalSection: null,
  openSettingsModal: (section?: SettingsSectionId) =>
    set({ settingsModalSection: section ?? DEFAULT_SETTINGS_SECTION }),
  closeSettingsModal: () => set({ settingsModalSection: null }),

  peopleWallOpen: false,
  openPeopleWall: () => set({ peopleWallOpen: true }),
  closePeopleWall: () => set({ peopleWallOpen: false }),
  togglePeopleWall: () => set({ peopleWallOpen: !get().peopleWallOpen }),

  // The ONE conversation allowed to share the stage with a working page (a
  // task, a doc). Opening another replaces it — stage panes swap, they never
  // accumulate, so the layout can never grow past page + companion + rail.
  workspace: (() => {
    const prefs = readCriticalUiPrefs() as any;
    const device = readDeviceWorkspace();
    const ws = hydrateWorkspace(prefs.workspace, device);
    // One-time inheritance from the terminal's own key, so an existing user's
    // dock opens exactly as they left it before the dock became a slot.
    if (!device) {
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem("cast_term_panel") : null;
        const legacy = raw ? JSON.parse(raw) : null;
        if (legacy?.open) ws.dock = { pane: { kind: "terminal" }, presentation: "split", size: legacy.height };
        else if (typeof legacy?.height === "number") ws.dock = { ...ws.dock, size: legacy.height };
      } catch {}
    }
    // First boot after the migration: inherit the old sidebar pref so the nav
    // opens exactly as the user left it.
    if (!prefs.workspace && prefs.sidebar_collapsed) ws.nav.presentation = "collapsed";
    return ws;
  })(),

  wsShow: action(function (this: Draft, slot: SlotId, pane: Pane, opts?: { presentation?: Presentation }) {
    this.workspace = showPane(this.workspace as WorkspaceState, slot, pane, opts);
    persistWorkspace(this);
  }),
  wsHide: action(function (this: Draft, slot: SlotId, opts?: { remember?: boolean }) {
    this.workspace = hidePane(this.workspace as WorkspaceState, slot, opts);
    persistWorkspace(this);
  }),
  wsToggle: action(function (this: Draft, slot: SlotId, pane: Pane) {
    this.workspace = togglePane(this.workspace as WorkspaceState, slot, pane);
    persistWorkspace(this);
  }),
  wsPromote: action(function (this: Draft, slot: SlotId) {
    this.workspace = wsPromotePure(this.workspace as WorkspaceState, slot);
    persistWorkspace(this);
  }),
  wsSetPresentation: action(function (this: Draft, slot: SlotId, presentation: Presentation) {
    this.workspace = wsSetPresentationPure(this.workspace as WorkspaceState, slot, presentation);
    persistWorkspace(this);
  }),
  // One action owns "is the nav folded", so the header button, the shortcut and
  // the drag-to-zero handler can't drift apart.
  // The dock is a slot like any other; SLOT_PERSISTENCE says its arrangement
  // stays on this device, so no component needs its own storage to say so.
  setDockOpen: (open: boolean) => {
    const st = get();
    if (open) st.wsShow("dock", TERMINAL_PANE);
    else st.wsHide("dock", { remember: true });
  },

  setNavCollapsed: action(function (this: Draft, collapsed: boolean) {
    this.workspace = wsSetPresentationPure(this.workspace as WorkspaceState, "nav", collapsed ? "collapsed" : "split");
    persistWorkspace(this);
  }),

  wsSetSize: action(function (this: Draft, slot: SlotId, size: number) {
    this.workspace = wsSetSizePure(this.workspace as WorkspaceState, slot, size);
    persistWorkspace(this);
  }),

  // Switch to a workbench: the WHOLE chrome — every slot, every size, zen —
  // restores in one draft, so the frame changes in a single paint. Subjects are
  // re-derived from where you are (the comments pane gets the conversation on
  // screen); a device that cannot host a terminal never inherits one.
  activeWorkbenchId: null,

  applyWorkbench: action(function (this: Draft, snap: WorkbenchSnapshot, id?: string, pathname?: string | null) {
    const conversationId = this.currentSessionId ?? this.viewingDismissedId ?? null;
    const allowTerminal = typeof window === "undefined" || window.innerWidth >= 768;
    this.workspace = applyWorkbenchPure(this.workspace as WorkspaceState, snap, { conversationId, allowTerminal });
    this.activeWorkbenchId = id ?? null;
    persistWorkspace(this);
    const zen = snap.zen ?? false;
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    if ((this.clientState.ui.zen_mode ?? false) !== zen) {
      this.clientState.ui.zen_mode = zen;
      writeCriticalUiPrefs({ zen_mode: zen });
    }
    // The chip rides along with the panes. Both axes are assigned together
    // rather than through the single-axis setters, whose "don't clobber the
    // other axis's exclude" guards exist for one-chip clicks; here the whole
    // filter is being replaced at once — including with nothing, which is what
    // a layout saved with a clear chip (or an older save, from before this
    // field) means.
    const prev = snapshotInboxViewFromDraft(this);
    const want = resolveWorkbenchFilter(snap.filter, this.buckets);
    this.activeBucketFilter = want.bucket;
    this.activeProjectFilter = want.project;
    this.activeProjectPath = want.projectPath;
    this.chipFilterExclude = want.exclude;
    const next = snapshotInboxViewFromDraft(this);
    if (sameInboxView(prev, next)) return;
    pushInboxViewHistory(prev, next);
    // The landing surface is passed in: a layout can change surface, and the
    // active tab still shows the one being left.
    evictFocusOutsideOrderInDraft(this, sessionFocusKind(pathname, this.currentConversation?.source));
  }),

  // Save and update reuse the saved-view pipeline wholesale (optimistic stub,
  // outbox, share/delete); a workbench is just a view whose page is the
  // workspace. Update IS the adjust gesture: arrange the chrome, overwrite.
  saveWorkbench: (name: string, path?: string) => {
    const st = get();
    const snap = captureWorkbench(st.workspace as WorkspaceState, {
      zen: st.clientState.ui?.zen_mode ?? false,
      path,
      filter: chipFilterOf(st),
    });
    return st.createSavedView({ name, page: "workspace", prefs: snap });
  },

  updateWorkbench: (id: string, path?: string) => {
    const st = get();
    const prev = (st.savedViews as Record<string, SavedViewRow>)[id]?.prefs as WorkbenchSnapshot | undefined;
    const snap = captureWorkbench(st.workspace as WorkspaceState, {
      zen: st.clientState.ui?.zen_mode ?? false,
      // Keep the workbench's surface unless the caller states a new one — an
      // update from a different page shouldn't silently retarget the switch.
      path: path ?? prev?.path,
      filter: chipFilterOf(st),
    });
    st.updateSavedView(id, { prefs: snap });
  },




  sidePanelSessionId: null,

  openSidePanel: action(function (this: Draft, sessionId: string) {
    this.sidePanelSessionId = sessionId;
    this.workspace = showPane(this.workspace as WorkspaceState, "context", SESSION_LIST_PANE);
    persistWorkspace(this);
  }),

  closeSidePanel: action(function (this: Draft) {
    this.sidePanelSessionId = null;
    this.workspace = hidePane(this.workspace as WorkspaceState, "context", { remember: true });
    persistWorkspace(this);
  }),

  clearSidePanelSession: action(function (this: Draft) {
    this.sidePanelSessionId = null;
  }),

  toggleSidePanel: action(function (this: Draft) {
    const ws = this.workspace as WorkspaceState;
    if (isSessionRailOpen(ws)) {
      this.workspace = hidePane(ws, "context", { remember: true });
    } else {
      this.workspace = showPane(ws, "context", SESSION_LIST_PANE);
      this.sidePanelSessionId = this.sidePanelSessionId ?? this.currentSessionId ?? null;
    }
    persistWorkspace(this);
  }),


  selectPanelSession: action(function (this: Draft, sessionId: string | null) {
    // Clicking the session that's already open in the right panel exits it — the
    // same click that peeks a session beside the page dismisses it on a repeat.
    // Mirrors the panel's close button (which calls selectPanelSession(null));
    // we leave sidePanelOpen alone so the session-list rail stays as it was.
    if (sessionId && sessionId === this.sidePanelSessionId) {
      this.sidePanelSessionId = null;
      return;
    }
    // The side panel is a genuine way of viewing a session (used by the Tab
    // switcher off the inbox page), so record it. Its "previous" is the panel's
    // own session, not the main currentSessionId.
    if (sessionId) recordSessionView(this, sessionId, this.sidePanelSessionId);
    this.sidePanelSessionId = sessionId;
  }),

  // =====================
  // TABS
  // =====================

  tabs: [],
  activeTabId: null,

  openTab: action(function (this: Draft, opts: { title: string; path: string; sessionId?: string; makeActive?: boolean }) {
    // A detached tab window renders no tab shell, so a tab opened there would
    // be invisible here AND appear out of nowhere in the main window (tabs are
    // shared state). Whatever asked for a tab really asked to show a page —
    // navigate this window to it instead.
    if (typeof window !== "undefined" && (window as any).__CODECAST_ELECTRON__?.isTabWindow === true) {
      window.location.assign(opts.path);
      return "";
    }
    // A pathless tab is unrenderable and PERSISTS — it crashed the TabBar on
    // every boot until the store was hand-repaired. Refuse it at the door.
    if (!opts?.path || typeof opts.path !== "string") return "";
    const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tab: AppTab = {
      id,
      title: opts.title,
      // Only a shell route: the desktop boots at `/`, and a first tab seeded
      // from that URL rendered a blank stage on every launch (lib/tabRoutes).
      path: shellTabPath(opts.path),
      sessionId: opts.sessionId,
      createdAt: Date.now(),
    };
    this.tabs = [...this.tabs, tab];
    if (opts.makeActive !== false) {
      // The tab being left behind keeps its frame; the new tab has no
      // snapshot yet, so it inherits the frame it was opened under.
      stampActiveTab(this);
      this.activeTabId = id;
    }
    return id;
  }),

  closeTab: action(function (this: Draft, id: string) {
    const idx = this.tabs.findIndex((t: AppTab) => t.id === id);
    if (idx === -1) return;
    let newTabs = this.tabs.filter((t: AppTab) => t.id !== id);
    if (this.activeTabId === id) {
      const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
      this.activeTabId = nextTab?.id ?? null;
      // A background tab often holds the canonicalized /conversation/<id> path
      // (stamped from window.location by switchTab), whose pane is a spent
      // RedirectToInbox — a loading skeleton that already fired its one-shot
      // redirect while hidden. Every transition onto a tab heals this via a
      // freshly-mounted redirect targeting the active tab, EXCEPT close, which
      // just promotes the survivor. Rewrite to the inbox deep-link form the
      // redirect would have produced so the pane remounts with real content.
      if (nextTab && conversationTabPath(nextTab.path) !== nextTab.path) {
        newTabs = newTabs.map((t: AppTab) =>
          t.id === nextTab.id ? { ...t, path: conversationTabPath(t.path) } : t,
        );
      }
      this.tabs = newTabs;
      // Close promotes the survivor without a switchTab, so restore its
      // frozen frame here — the dying tab's frame dies with it.
      restoreTabWorkspace(this, nextTab);
      return;
    }
    this.tabs = newTabs;
  }),

  // Switching tabs swaps the WHOLE frozen view: the outgoing tab is stamped
  // with the live frame (panes, presentations, sizes, rail subject), and the
  // incoming tab's stamped frame is put back on screen. A tab that never
  // stamped one keeps the current frame.
  switchTab: action(function (this: Draft, id: string) {
    if (this.activeTabId === id) return;
    stampActiveTab(this);
    this.activeTabId = id;
    restoreTabWorkspace(this, this.tabs.find((t: AppTab) => t.id === id));
  }),

  updateTab: action(function (this: Draft, id: string, patch: Partial<AppTab>) {
    const current = this.tabs.find((t: AppTab) => t.id === id);
    if (!current) return;
    // A path outside the shell never lands in a tab (lib/tabRoutes); the tab
    // keeps what it showed rather than taking a path no pane renders.
    if (patch.path !== undefined && isNonTabRoute(patch.path)) {
      const { path: _dropped, ...rest } = patch;
      patch = rest;
    }
    let changed = false;
    for (const k in patch) {
      if ((current as any)[k] !== (patch as any)[k]) { changed = true; break; }
    }
    if (!changed) return;
    this.tabs = this.tabs.map((t: AppTab) => t.id === id ? { ...t, ...patch } : t);
  }),

  saveCurrentTabState: action(function (this: Draft, patch?: Partial<AppTab>) {
    if (!this.activeTabId) return;
    stampActiveTab(this, patch);
  }),

  // =====================
  // CACHED QUERY DATA
  // =====================

  currentUser: null,
  teams: [],
  teamMembers: [],
  teamUnreadCount: null,
  favorites: [],
  bookmarks: [],
  bookmarkPending: {},
  myStatusPending: null,

  myCalls: { incoming: [], outgoing: [], membership: null },
  callOccupancy: {},
  callConfig: null,
  liveRooms: [],
  roomKnocks: [],
  callKnocked: {},
  callLockPending: {},
  call: {
    phase: "idle" as const,
    roomKey: null,
    muted: true,
    micDenied: false,
    camera: false,
    sharing: false,
    speaking: [],
    error: null,
  },
  // Raw set() by convention: ephemeral UI/media state, never shared or
  // persisted (same class as modal toggles).
  setCallState: (patch: Partial<InboxStoreState["call"]>) =>
    set((s: any) => ({ call: { ...s.call, ...patch } })),

  // Raw set() by the same convention as the call slice: ephemeral media-plane
  // bookkeeping, never persisted and never dispatched. A knock and a lock
  // toggle are both server gestures whose durable state comes back through
  // liveRooms/roomKnocks; these hold only what the client must render before
  // that echo lands.
  noteKnock: (roomKey: string) =>
    set((s: any) => ({ callKnocked: { ...s.callKnocked, [roomKey]: Date.now() } })),
  clearKnock: (roomKey: string) =>
    set((s: any) => {
      if (!(roomKey in s.callKnocked)) return {};
      const next = { ...s.callKnocked };
      delete next[roomKey];
      return { callKnocked: next };
    }),
  noteLockPending: (roomKey: string, locked: boolean) =>
    set((s: any) => ({
      callLockPending: { ...s.callLockPending, [roomKey]: { locked, at: Date.now() } },
      // Paint the flip now — the liveRooms echo reconciles, and the pending
      // entry above keeps an in-flight push from reverting it meanwhile.
      liveRooms: (s.liveRooms as any[]).map((r) =>
        r.room_key === roomKey ? { ...r, locked } : r,
      ),
    })),
  // The mutation was refused: paint the state it never left and stop
  // protecting it. Without this the optimistic glyph would stand until some
  // unrelated change happened to re-push getLiveRooms.
  revertLockPending: (roomKey: string, locked: boolean) =>
    set((s: any) => {
      const next = { ...s.callLockPending };
      delete next[roomKey];
      return {
        callLockPending: next,
        liveRooms: (s.liveRooms as any[]).map((r) =>
          r.room_key === roomKey ? { ...r, locked } : r,
        ),
      };
    }),

  // =====================
  // SELECTORS
  // =====================

  getSession: (id: string) => {
    return get().sessions[id];
  },

  // =====================
  // TEAM CHAT
  // =====================
  // Collections, optimistic writers and their durable dispatch actions. Kept in
  // store/chatSlice.ts so the whole surface reads as one thing; spread here so
  // the middleware wraps every action exactly as if it were written inline.
  ...createChatSlice(set, get),

});

function createInboxStore() {
  return create<InboxStoreState>(mutativeMiddleware(inboxStoreConfig) as any);
}

// -- Dev hot swap --
//
// This module exports a hook and actions, never components, so React Fast
// Refresh cannot make it an update boundary. Vite then walks the importers for
// one and finds none: lib/sounds imports the store straight back (a cycle), and
// lib/errorToast reaches src/boot.tsx, which is the entry and has no importers
// at all. The fallback is a full page reload, and that costs ~4s of Convex
// WebSocket handshake before any data comes back — for editing one action.
//
// So the module self-accepts instead. The accept call is appended by
// plugins/storeHmr.ts rather than written here, because Metro bundles this same
// file for the Expo app and Hermes cannot parse `import.meta` (same reason the
// dev console hook below reads NODE_ENV). On re-execution the surviving store is
// reused, so every importer's `useInboxStore` reference stays valid and the
// state stays in memory; _hotReplaceConfig swaps in the new action bodies.
//
// That only holds for the actions. A self-accepting module leaves its importers
// untouched, so they keep their old copy of every other export here — the
// selectors, classifySession, sortSessions and the rest. The plugin watches for
// exactly that: it fingerprints everything outside `inboxStoreConfig` below and
// reloads instead of swapping when it changes, so an edit never appears to apply
// and then quietly do nothing. Keep the two markers it splits on intact.
//
// `document` is the web/native split — React Native has no document, so a Metro
// Fast Refresh keeps the plain create() path it has always used.
const hotSwapCapable = process.env.NODE_ENV !== "production" && typeof document !== "undefined";
const survivingInboxStore: ReturnType<typeof createInboxStore> | undefined = hotSwapCapable
  ? (globalThis as any).__codecastInboxStore
  : undefined;

export const useInboxStore = survivingInboxStore ?? createInboxStore();

if (survivingInboxStore) {
  (survivingInboxStore.getState() as any)._hotReplaceConfig?.(inboxStoreConfig);
} else if (hotSwapCapable) {
  (globalThis as any).__codecastInboxStore = useInboxStore;
}

function cloneInitialValue<T>(value: T): T {
  if (value instanceof Set) return new Set(value) as T;
  if (value instanceof Map) return new Map(value) as T;
  if (Array.isArray(value)) return value.map(cloneInitialValue) as T;
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = cloneInitialValue(child);
    }
    return copy as T;
  }
  return value;
}

// Captured before any protected hydration. Functions remain installed in the
// middleware; every data-bearing slot returns to this account-neutral floor.
const INITIAL_INBOX_DATA = Object.fromEntries(
  Object.entries(useInboxStore.getState())
    .filter(([, value]) => typeof value !== "function")
    .map(([key, value]) => [key, cloneInitialValue(value)]),
);

/** Synchronous gate used before an old principal store is closed or purged. */
export function clearProtectedInboxMemory(): void {
  const state = useInboxStore.getState() as any;
  state._clearRuntimeBindings?.();
  const reset = Object.fromEntries(
    Object.entries(INITIAL_INBOX_DATA).map(([key, value]) => [key, cloneInitialValue(value)]),
  ) as Record<string, any>;
  // These few device layout preferences are explicitly account-neutral and
  // already mirrored to localStorage; no server or principal data is retained.
  reset.clientState = { ui: readCriticalUiPrefs() as ClientUI };
  reset.clientStateInitialized = false;
  useInboxStore.setState(reset);
  _idbHydrating.clear();
}

// =====================
// STORE PROXY
// =====================

type StoreProxy = InboxStoreState & { use: typeof useInboxStore };

export const store = new Proxy({} as StoreProxy, {
  get(_, prop) {
    if (prop === "use") return useInboxStore;
    const state = useInboxStore.getState();
    const val = (state as any)[prop];
    return val;
  },
});

// Dev console access (e.g. drive deep-link navigation via
// __inboxStore.getState().requestNavigate(id, { scrollToMessageId }) — raw
// setState writes to the view fields are reverted by the middleware's view
// guard; see viewNav.ts and __navLog()). NODE_ENV (not
// import.meta.env.DEV): this module is shared with the Expo app, and Hermes
// can't parse `import.meta`; both Vite and Metro statically replace NODE_ENV.
// The ambient declare stands in for node types (not in the web tsconfig).
declare const process: { env: { NODE_ENV?: string } };
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") (window as any).__inboxStore = useInboxStore;

// =====================
// TRACKED STORE HOOK
// =====================
// Declare what to watch, access the full state.
// Re-renders only when a dep's return value changes (Object.is).
//
//   const s = useTrackedStore([s => s.messages[id], s => s.sessions[id]]);
//   s.conversations[id]  // full state access
//   s.getSession(id)     // getters work too
//
export function useTrackedStore(deps: Array<(s: InboxStoreState) => any>): InboxStoreState {
  const prevRef = useRef<{ deps: any[]; state: InboxStoreState } | null>(null);
  return useSyncExternalStore(useInboxStore.subscribe, () => {
    const state = useInboxStore.getState();
    const next = deps.map(d => d(state));
    const prev = prevRef.current;
    if (prev && next.length === prev.deps.length &&
        next.every((v, i) => Object.is(v, prev.deps[i]))) {
      return prev.state;
    }
    if (process.env.NODE_ENV !== "production" && prev) {
      // Dev-only wake audit: which dep woke this subscriber, keyed by the dep's
      // source text. Read from the console as __depChanges().
      for (let i = 0; i < next.length; i++) {
        if (!Object.is(next[i], prev.deps[i])) {
          const k = ((deps[i] as any).label ?? String(deps[i])).slice(0, 120);
          _depChanges.set(k, (_depChanges.get(k) || 0) + 1);
        }
      }
    }
    prevRef.current = { deps: next, state };
    return state;
  });
}
const _depChanges = new Map<string, number>();
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__depChanges = (reset?: boolean) => {
    const out = [..._depChanges.entries()].sort((a, b) => b[1] - a[1]);
    if (reset) _depChanges.clear();
    return out;
  };
  // Which sessions' STRUCTURAL signature changed since the last call, and how
  // (the sig parts that differ). Names the field behind a sessionsWakeSig wake.
  let _sigSnap: Record<string, string> = {};
  (window as any).__sessionSigDiff = () => {
    const sessions = useInboxStore.getState().sessions;
    const next: Record<string, string> = {};
    const changed: Array<{ id: string; title?: string; diff: Array<[number, string, string]> }> = [];
    for (const id in sessions) {
      const sig = sessionStructuralSig(sessions[id]);
      next[id] = sig;
      const prev = _sigSnap[id];
      if (prev !== undefined && prev !== sig) {
        const a = prev.split(","), b = sig.split(",");
        const diff: Array<[number, string, string]> = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push([i, a[i], b[i]]);
        changed.push({ id: id.slice(0, 7), title: sessions[id].title?.slice(0, 40), diff });
      }
    }
    _sigSnap = next;
    return changed;
  };
}

// -- Per-conversation IDB hydration (idempotent, no hooks) --
// Tracks in-flight hydrations (not "ever hydrated") so evicted conversations
// can be re-hydrated from IDB when the user switches back to them.
// Resolves true once the conversation holds messages in memory (already there,
// or restored from IndexedDB), false on a genuine cache miss or storage error.
// Callers that would otherwise fetch from the network can await this and skip
// the round-trip on a warm cache — the inbox cold-warm used to fire a
// listMessages for every row it didn't hold in MEMORY, which on a relaunch was
// all of them, even though IDB had the tail for nearly every one.
const _idbHydrating = new Map<string, Promise<boolean>>();
// Conversations whose messages were already in memory when we went to disk
// for the navigator list alone. Probed once: ensureHydrated runs on every
// ConversationView render, and a conversation with no persisted list must not
// cost an IDB read per render. Eviction drops messages and the list together,
// so the next full hydration re-reads both regardless of this set.
const _userMsgsProbed = new Set<string>();
export function ensureHydrated(convId: string): Promise<boolean> {
  const store = useInboxStore.getState();
  const hasMessages = store.messages[convId]?.length > 0;
  // Already in memory — nothing to hydrate
  if (hasMessages && (store.userMessages[convId] || _userMsgsProbed.has(convId))) return Promise.resolve(true);
  // In-flight hydration — don't double-load
  const inflight = _idbHydrating.get(convId);
  if (inflight) return inflight;
  if (hasMessages) _userMsgsProbed.add(convId);
  const p = loadConversationMessages(convId).then((cached) => {
    _idbHydrating.delete(convId);
    const s = useInboxStore.getState();
    if (cached?.userMessages && !s.userMessages[convId]) s.setUserMessages(convId, cached.userMessages);
    if (!cached || cached.messages.length === 0) return hasMessages;
    if (s.messages[convId]?.length > 0) return true;
    s.setMessages(convId, cached.messages, cached.pagination);
    return true;
  }).catch(() => {
    _idbHydrating.delete(convId);
    // Never reinterpret a storage error as an authoritative empty conversation.
    return hasMessages;
  });
  _idbHydrating.set(convId, p);
  return p;
}

// Cache-as-floor hydration merge for id-keyed collections. IndexedDB rows are
// the base; whatever live data already landed in the store wins per-id. A
// windowed live payload — listInboxSessions' recent window, tasks.webList's
// take(300) — must never empty-gate out the full cached collection: that race
// (live fills the store before the deferred IDB hydration runs) is what made
// tasks/sessions collapse to the live window on every load and stream back in.
// Union-merge backfills the omitted rows while keeping live freshness; genuine
// deletions are reconciled by the reconcile crawl's authoritative onComplete
// snapshot, not by hydration.
export function unionHydrate<T extends Record<string, unknown>>(
  idbVal: T | undefined,
  liveVal: T | undefined,
): T {
  return { ...(idbVal ?? {}), ...(liveVal ?? {}) } as T;
}

// How one cached value re-enters the store over whatever live sync already
// wrote, per the registry's merge strategy. "fill" keys (live-synced
// singletons) only land while the slot is still null; everything else merges
// by shape — objects union (cache as floor, live wins per key), arrays fill
// only an empty slot, scalars replace.
export function hydrateMergeValue(
  key: string,
  val: unknown,
  cur: unknown,
): { apply: boolean; value?: unknown } {
  if (hydrationMergeStrategy(key) === "fill") {
    return cur == null ? { apply: true, value: val } : { apply: false };
  }
  if (Array.isArray(val)) {
    return (cur as unknown[] | undefined)?.length === 0
      ? { apply: true, value: val }
      : { apply: false };
  }
  if (typeof val === "object") {
    return {
      apply: true,
      value: unionHydrate(val as Record<string, unknown>, cur as Record<string, unknown> | undefined),
    };
  }
  return { apply: true, value: val };
}

// Drop persisted feedHasMore=false entries (in place) so they hydrate as
// "unknown" instead of as a dead latch. False used to stick durably off one
// bad page — the server could return an empty page mid-history (a window of
// filtered-out rows), the client persisted false, and the seed effect (which
// only writes when the key is absent) could never undo it: feed pagination
// stayed dead on that device forever. A true end-of-history loses nothing:
// feedCursors[key] === null short-circuits loadMore before any network.
export function dropLatchedFeedHasMore(feedHasMore: unknown): void {
  if (!feedHasMore || typeof feedHasMore !== "object") return;
  const map = feedHasMore as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (map[key] === false) delete map[key];
  }
}

// Decide what feed pagination state to persist after an older-page fetch.
// A non-null nextCursor is always trusted (the server promises continuation).
// A null cursor is only trusted as END OF HISTORY when the page carried rows:
// an unauthenticated/blipped query returns the identical empty+null shape, and
// persisting that null used to kill pagination on the device for good — the
// cursor twin of the feedHasMore latch above. `cursor: undefined` = keep the
// existing resume point.
export function feedPagePersistence(page: { rowCount: number; nextCursor: string | null }): {
  cursor: string | null | undefined;
  hasMore: boolean;
} {
  if (page.nextCursor != null) return { cursor: page.nextCursor, hasMore: true };
  if (page.rowCount > 0) return { cursor: null, hasMore: false };
  return { cursor: undefined, hasMore: false };
}

// -- IndexedDB cache: wire patch-driven writes + hydrate on load --

// Boot-seed liveInboxIds from its persisted twin. Guarded: only a non-empty
// cached array lands, and only while the in-memory set is still empty — if a
// live payload raced hydration and landed first (size > 0), the fresher server
// truth wins and the stale snapshot is discarded. Raw setState on purpose: the
// value came FROM disk, so re-persisting it through the sync() action would be
// a pointless IDB write during hydration.
export function seedLiveInboxIdsFromCache(cachedList: unknown) {
  if (!Array.isArray(cachedList) || cachedList.length === 0) return;
  if (useInboxStore.getState().liveInboxIds.size > 0) return;
  const ids = cachedList.filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return;
  useInboxStore.setState({ liveInboxIds: new Set(ids), liveInboxIdList: ids });
}

// Team-mode analogue of seedLiveInboxIdsFromCache. Extra guards: only seeds
// when the client boots IN team scope with the SAME active team the snapshot
// was taken for — a snapshot from another team (or a client since switched to
// "mine") must never gate the board. Runs after clientState hydrates (the
// scope/team prefs live there), same synchronous pass.
export function seedTeamInboxIdsFromCache(cachedSnapshot: unknown) {
  const snap = cachedSnapshot as { team_id?: string | null; ids?: unknown } | null | undefined;
  if (!snap || !Array.isArray(snap.ids) || snap.ids.length === 0) return;
  const state = useInboxStore.getState();
  if (state.teamInboxIds.size > 0) return; // live payload raced hydration — server truth wins
  const ui = state.clientState.ui;
  if ((ui?.inbox_scope ?? "mine") !== "team") return;
  if ((snap.team_id ?? null) !== (ui?.active_team_id ?? null)) return;
  const ids = snap.ids.filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return;
  useInboxStore.setState({
    teamInboxIds: new Set(ids),
    teamInboxIdSnapshot: { team_id: snap.team_id ?? null, ids },
  });
}

// -- IndexedDB cache: wire patch-driven writes + hydrate on load --
async function hydrateInboxCacheFromIDB(): Promise<boolean> {
  if (!PERSISTENCE_AVAILABLE) return false;

  (useInboxStore.getState() as any)._setIDBWrite(writePatchesToIDB);
  (useInboxStore.getState() as any)._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
  (useInboxStore.getState() as any)._setStorageHealth?.((healthy: boolean) => {
    if (useInboxStore.getState().storageDegraded === !healthy) return;
    useInboxStore.setState({ storageDegraded: !healthy });
  });

  // Salvage any writes parked in the retired local-first v2 databases, then
  // delete those databases. Runs before the first drain can matter: the drain
  // re-fires below once salvage lands rows.
  void salvageLocalFirstV2Data().then((salvaged) => {
    if (salvaged > 0) (useInboxStore.getState() as any)._drainOutbox?.();
  });

  setHydrating(true);
  const cached = await loadCache();
  if (!cached) {
    setHydrating(false);
    useInboxStore.setState({ clientStateInitialized: true });
    return true;
  }

    const apply = (pick: string[]) => {
      const state = useInboxStore.getState();
      const updates: Record<string, any> = {};
      for (const key of pick) {
        const val = cached[key];
        if (val == null) continue;
        const cur = (state as any)[key];
        if (key === "clientState" && state.clientStateInitialized) {
          // Merge tips (set_union)
          const cachedTips = val?.tips;
          if (cachedTips) {
            const cur = state.clientState.tips ?? {} as any;
            const merged: Record<string, any> = {};
            let changed = false;
            for (const k of ["seen", "dismissed", "completed"] as const) {
              const union = [...new Set([...((cur as any)[k] ?? []), ...(cachedTips[k] ?? [])])];
              if (union.length > ((cur as any)[k]?.length ?? 0)) { merged[k] = union; changed = true; }
            }
            if (changed) state.updateClientTips(merged);
          }
          // Merge ui fields that may only exist in IDB (saved_views, etc.)
          const cachedUI = val?.ui;
          if (cachedUI) {
            const curUI = state.clientState.ui ?? {};
            const uiPatch: Record<string, any> = {};
            for (const [uk, uv] of Object.entries(cachedUI)) {
              // Stamps ride along with their base key below, never alone — a
              // bare stale ":ts" would misdate whatever value is already live.
              if (uk.endsWith(":ts")) continue;
              if (uv != null && (curUI as any)[uk] == null) {
                uiPatch[uk] = uv;
                const ts = (cachedUI as any)[`${uk}:ts`];
                // Keep the ORIGINAL write time (updateClientUI honors a passed
                // stamp) so this boot-time restore can't outrank a genuinely
                // newer write from another device.
                if (typeof ts === "number") uiPatch[`${uk}:ts`] = ts;
              }
            }
            if (Object.keys(uiPatch).length > 0) state.updateClientUI(uiPatch);
          }
          continue;
        }
        if (key === "clientState") {
          // Cold-start path. clientState may have a small localStorage seed
          // (sidebar_collapsed, zen_mode, etc.) — preserve those and fill in
          // everything else from IDB. Deep-merge nested objects (ui, dismissed,
          // layouts, tips) so a single seeded ui key doesn't shadow the rest.
          const merged: Record<string, any> = { ...val };
          for (const subKey of Object.keys(cur || {})) {
            const curSub = (cur as any)[subKey];
            const cachedSub = (val as any)[subKey];
            if (
              curSub && typeof curSub === "object" && !Array.isArray(curSub) &&
              cachedSub && typeof cachedSub === "object" && !Array.isArray(cachedSub)
            ) {
              // Local seed wins per-key; cached fills in the rest.
              merged[subKey] = { ...cachedSub, ...curSub };
            } else if (curSub != null) {
              merged[subKey] = curSub;
            }
          }
          updates[key] = merged;
          continue;
        }
        const merge = hydrateMergeValue(key, val, cur);
        if (merge.apply) updates[key] = merge.value;
      }
      if (Object.keys(updates).length > 0) {
        if (updates.clientState) updates.clientStateInitialized = true;
        useInboxStore.setState(updates);
      }
    };

    // Strip stale large fields from cached conversations (git_diff, git_diff_staged, available_skills)
    if (cached.conversations && typeof cached.conversations === "object") {
      for (const conv of Object.values(cached.conversations) as any[]) {
        if (conv) { delete conv.git_diff; delete conv.git_diff_staged; delete conv.available_skills; }
      }
    }

    // Legacy disk rows under unregistered keys (the old monolithic messages /
    // pagination meta blobs) can't leak in: apply() walks registry-derived key
    // lists only. Messages load per-conversation from their own IDB table.

    // A persisted optimistic message whose image is still `uploading` was
    // orphaned by a reload mid-upload: the in-memory upload+send task didn't
    // survive, and resolvePendingUploads (which clears the flag) never ran. It
    // can't complete on its own, so surface it as failed instead of a forever
    // spinner, and drop the now-dead blob preview.
    if (cached.pendingMessages && typeof cached.pendingMessages === "object") {
      for (const msgs of Object.values(cached.pendingMessages) as Message[][]) {
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          if ((m as any)?.images?.some((img: any) => img?.uploading)) {
            (m as any)._isFailed = true;
            (m as any).images = (m as any).images.filter((img: any) => !img?.uploading);
          }
        }
      }
    }

    // A persisted feedHasMore=false is dropped at hydration (treated as
    // unknown) — it used to latch durably off one bad page and nothing could
    // ever undo it (the seed effect only writes when the key is absent), which
    // killed feed pagination on that device for good. A true end-of-history is
    // re-confirmed for free: feedCursors[key] === null short-circuits loadMore
    // before any network.
    dropLatchedFeedHasMore(cached.feedHasMore);

    // Critical path: everything needed for first paint (sidebar, current
    // conversation, tabs, label groups, team feed). Derived from the registry —
    // a persisted key hydrates here unless it opted into the deferred phase or
    // "manual" handling, so a new key can never silently skip hydration (the
    // ct-34920 / buckets-pop-in bug class).
    apply(HYDRATION_CRITICAL_KEYS);

    // Seed the authoritative active set from its persisted twin (manual
    // hydration — see clientSyncRegistry). Same synchronous pass as the
    // sessions apply above, so the first frame that shows cached sessions
    // already filters them to the last-known server set: no cold-boot flash of
    // aged-out rows. The live subscription / recovery poll replace it within
    // ~1s of connecting.
    seedLiveInboxIdsFromCache(cached.liveInboxIdList);
    seedTeamInboxIdsFromCache(cached.teamInboxIdSnapshot);

    // Always mark initialized after IDB hydration completes — even if cached
    // clientState was missing — so app gates don't hang on fresh users.
    if (!useInboxStore.getState().clientStateInitialized) {
      useInboxStore.setState({ clientStateInitialized: true });
    }

    // Restore the selected session before React effects can auto-select the
    // first session (QueuePageClient's fallback effect). Prefer this client's
    // OWN last position (lastFocusedConversationId, local-only); the per-user
    // synced pointer is a fallback for clients with no local history ONLY —
    // it is writable by every other client (devices, agent-driven tabs), and
    // restoring from it here is what kept teleporting the desktop into random
    // sessions after every dev reload (ct-36951; the round-1 fix gated the
    // server-sync pull but this hydration path was the live door).
    const st = useInboxStore.getState();
    // A tab persisted with a path the shell cannot render (older builds
    // stamped the live URL unchecked) heals to the inbox before first paint.
    const healedTabs = healTabPaths(st.tabs);
    if (healedTabs !== st.tabs) useInboxStore.setState({ tabs: healedTabs });
    const ownId = (cached.lastFocusedConversationId ?? null) as string | null;
    if (ownId && !st.lastFocusedConversationId) {
      useInboxStore.setState({ lastFocusedConversationId: ownId });
    }
    if (!st.currentSessionId) {
      const restoreId = ownId ?? st.clientState?.current_conversation_id;
      if (restoreId && st.sessions[restoreId]) {
        // The divider anchor (_seenUpToAt) is persisted, so reopening the app to
        // this session naturally shows what arrived while it was closed — no
        // special seeding needed here.
        declareViewNav("boot-restore");
        useInboxStore.setState({ currentSessionId: restoreId });
      }
    }

    // Preload messages for the active inbox sessions so clicks are instant.
    // Scope: the authoritative live set + the restored focus target — NOT every
    // cached session row. Iterating the whole cache here meant thousands of IDB
    // probes at boot and loaded messages for hundreds of conversations straight
    // into memory for the eviction cap to fight back out. Anything else
    // hydrates on demand (ensureHydrated on open / the inbox warm loop).
    const preloadIds = new Set<string>(cached.liveInboxIdList ?? []);
    const focusId = useInboxStore.getState().currentSessionId;
    if (focusId) preloadIds.add(focusId);
    for (const id of preloadIds) ensureHydrated(id);

    // Deferred: list views + secondary data hydrate just after first paint.
    // setTimeout, NOT requestAnimationFrame: rAF is paused in background tabs, so
    // with the gate release below tied to it, a backgrounded tab would never
    // finish hydrating and never re-enable IDB writes (stuck `_hydrating`). With
    // the user running many session tabs, most are backgrounded — they must still
    // hydrate and persist. setTimeout fires (throttled) even when hidden.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    apply(HYDRATION_DEFERRED_KEYS);
      // Re-enable IDB write-through only AFTER the deferred collections land.
      // If a live delta arrives while write-through is open but the store still
      // holds just the windowed payload (tasks' 300, sessions' ~30d), then
      // diffCollection would diff that window against the full on-disk shadow and
      // bulkDelete every cached row outside it — pruning the shared IndexedDB
      // before unionHydrate merges it back (the cross-tab "disappear then stream
      // back" race jx799py found). Post-hydration the store holds the full union,
      // so delta overlays never drop rows; write-through then deletes only on a
      // real removal (dismiss/kill) or the crawl's authoritative snapshot.
    setHydrating(false);
    return true;
}

// Persistence boots with the module: wire write-through and hydrate
// immediately. Nothing gates on auth — cached state renders first and live
// sync reconciles after (local-first is the law).
function bootPersistence(): void {
  if (PERSISTENCE_AVAILABLE) {
    void hydrateInboxCacheFromIDB().catch((error) => {
      console.error("[store] IDB hydration failed; continuing with live-only state", error);
      setHydrating(false);
      useInboxStore.setState({ clientStateInitialized: true });
    });
  } else {
    useInboxStore.setState({ clientStateInitialized: true });
  }
}

// Once per store, not once per module evaluation: after a dev hot swap the
// surviving store is already hydrated and still holds its IDB write-through and
// outbox bindings, so running this again would re-open the database and re-seed
// state that is live.
if (!survivingInboxStore) bootPersistence();
