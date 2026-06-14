import { create } from "zustand";
import { useSyncExternalStore, useRef } from "react";
import { mutativeMiddleware, action, asyncAction, sync } from "./mutativeMiddleware";
import { declareViewNav, hasViewNavigated, recordNavEvent, type ViewNavSource } from "./viewNav";
import { applySyncTable, applySyncRecord, type PendingEntry } from "./syncProtocol";
import { soundDismiss, soundKill } from "../lib/sounds";
import { loadCache, writePatchesToIDB, setHydrating, loadConversationMessages, writeConversationMessages, enqueueDispatch, removeDispatch, loadOutbox, PERSISTENCE_AVAILABLE } from "./idbCache";
import { HYDRATION_CRITICAL_KEYS, HYDRATION_DEFERRED_KEYS, hydrationMergeStrategy } from "./clientSyncRegistry";
// Single source of truth for the agent-status contract, shared with the Convex
// backend and the CLI daemon. See packages/shared/contracts/agentStatus.ts.
import { type AgentStatus, ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";

export type { PendingEntry } from "./syncProtocol";

export interface SessionContext {
  projectPath?: string;
  gitRoot?: string;
  agentType?: string;
  source?: "inbox" | "sessions";
}

const CONVEX_ID_RE = /^[a-z0-9]{32}$/;
export function isConvexId(id: string): boolean {
  return CONVEX_ID_RE.test(id);
}

// Canonical entity-derivation helpers live in lib/liveEntities. Re-exported here
// so existing call sites that import from the store keep working.
export { resolveAssigneeInfo, resolveSessionAuthor, computePlanProgress, mergeLiveTasks } from "../lib/liveEntities";
import { deriveDocDisplayTitle, isForeignSession } from "../lib/liveEntities";
import { DEFAULT_SETTINGS_SECTION, type SettingsSectionId } from "../lib/settingsSections";
import type { PendingComment } from "../lib/quoteFormat";
import { pushInboxViewHistory, isApplyingViewHistory, type InboxViewSnapshot } from "../lib/inboxViewHistory";

// Critical UI prefs mirrored to localStorage so they're available
// synchronously at module load — avoids a layout flash between first paint
// and IDB hydration. The IDB-backed clientState remains the source of truth
// across tabs; localStorage is just a sync-readable cache for first-paint
// values that affect layout. Keep this set TINY — every key here adds
// localStorage churn on every change.
const CRITICAL_UI_KEYS = ["sidebar_collapsed", "zen_mode", "inbox_shortcuts_hidden", "inbox_flat_view"] as const;
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
  progress?: { total: number; done: number; in_progress: number; open: number };
  task_count?: number;
  session_count?: number;
  created_at: number;
  updated_at: number;
};

export type ProjectItem = {
  _id: string;
  short_id?: string;
  title: string;
  description?: string;
  status: string;
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
  // Last-known model id (e.g. "claude-opus-4-8"); conversations can switch
  // models mid-stream. Shown as an inbox badge when ui.show_model_badge is on.
  model?: string | null;
  effort?: string | null;
  message_count: number;
  idle_summary?: string;
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
  is_deferred?: boolean;
  is_pinned?: boolean;
  // When the user pinned this session (Date.now() ms). Drives a stable order in
  // the Pinned group so cards don't reshuffle on agent status churn.
  inbox_pinned_at?: number | null;
  inbox_dismissed_at?: number | null;
  // Stash = set aside WITHOUT killing. Hides the session from the active
  // buckets into the Stashed group (above Dismissed) while the agent keeps
  // running. Same absolute-flag semantics as dismiss; a dismiss clears it.
  inbox_stashed_at?: number | null;
  last_user_message?: string | null;
  session_error?: string;
  // True when the session's latest turn is an unresolved Claude Code auth/API
  // error banner ("Please run /login · API Error: 401 …") — the CLI was signed
  // out / rate-limited mid-turn and is parked waiting on the user to
  // re-authenticate or retry. Surfaced by the server; routes the row to
  // needs-input and shows a distinct "login" badge. Self-clears when a real
  // turn supersedes the banner.
  pending_api_error?: boolean;
  // "auth" | "limit" | "error" — which banner family parked the session;
  // picks the badge label ("login" vs "limit").
  pending_api_error_kind?: string | null;
  implementation_session?: { _id: string; title?: string };
  is_subagent?: boolean;
  parent_conversation_id?: string;
  active_plan?: PlanRef;
  active_task?: TaskRef;
  worktree_name?: string | null;
  worktree_branch?: string | null;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean;
  workflow_run_status?: string | null;
  forked_from?: string | null;
  parent_message_uuid?: string | null;
  icon?: string;
  icon_color?: string;
  dismissed_at?: number;
  team_id?: string | null;
  is_private?: boolean;
  // Which device currently runs this session (null = unassigned; auto-routing
  // picks the most-recently-active local machine on next send).
  owner_device_id?: string | null;
  // The session's author (conversation.user_id). The inbox is user-scoped, so a
  // synced row is always the current user's own — but a teammate's session can be
  // INJECTED into this same cache (deep-link / search / command-palette open). The
  // card shows the author only when this isn't the current user. author_name/avatar
  // are the source-provided display fallback for injected rows whose author isn't on
  // the live team roster; otherwise the name/avatar derive from the roster by user_id.
  user_id?: string;
  author_name?: string | null;
  author_avatar?: string | null;
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
};


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
};

export type TaskViewPrefs = {
  status?: string;
  statuses?: string;
  view?: "list" | "kanban";
  sort?: string;
  priority?: string;
  label?: string;
  assignee?: string;
  session?: string;
  hide_agent?: boolean;
  source?: string;
};

export type DocViewPrefs = {
  doc_type?: string;
  sort?: string;
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
  sounds_enabled?: boolean;
  task_view?: TaskViewPrefs;
  doc_view?: DocViewPrefs;
  plan_view?: PlanViewPrefs;
  saved_views?: SavedView[];
  show_subagents?: boolean;
  show_old_sessions?: boolean;
  // Show each session's model as a badge in the inbox list. Off by default.
  show_model_badge?: boolean;
  // Inbox session panel view mode. When true, the panel drops the
  // Pinned/New/Needs-Input/Working grouping and shows every session as one flat
  // list sorted newest-first by creation time (started_at). Toggled by Ctrl+,.
  inbox_flat_view?: boolean;
  // Three-way successor to inbox_flat_view: "grouped" (status sections),
  // "time" (flat by creation), "bucket" (sections per manual bucket). The
  // boolean is kept coherent (true iff "time") for older readers. Ctrl+, cycles.
  inbox_view_mode?: "grouped" | "time" | "bucket";
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
  // "Set up account switching" promo inside that banner — permanent opt-out.
  cc_accounts_promo?: boolean;
};

export type ClientTips = {
  seen?: string[];
  dismissed?: string[];
  completed?: string[];
  level?: 'all' | 'subtle' | 'none';
  _inlineSuppressed?: boolean;
};

export type AppTab = {
  id: string;
  title: string;
  path: string;
  sessionId?: string;
  sidePanelSessionId?: string;
  sidePanelOpen?: boolean;
  sidePanelUserClosed?: boolean;
  createdAt: number;
};

export type ClientState = {
  current_conversation_id?: string;
  show_dismissed?: boolean;
  show_stashed?: boolean;
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
function sessionSortRank(s: InboxSession): [number, number, number, number, number, number] {
  return [
    s.is_pinned ? 0 : 1,                              // pinned first
    s.is_deferred ? 1 : 0,                            // deferred last
    isConvexId(s._id) ? 1 : 0,                        // optimistic stub ids first
    (s.message_count ?? 0) === 0 ? 0 : 1,            // brand-new (no messages) first
    isSessionWaitingForInput(s) ? 0 : 1,             // needs-input first
    isSessionEffectivelyIdle(s) ? 0 : 1,             // idle before active
  ];
}

export function sortSessions(sessions: Record<string, InboxSession>): InboxSession[] {
  // One O(N) classification pass, then an O(N log N) sort over cheap precomputed
  // keys. The previous version called isSessionWaitingForInput /
  // isSessionEffectivelyIdle / isConvexId inside the comparator — i.e. thousands
  // of times per sort — which dominated the constant re-categorize cost the
  // inbox pays on every liveness sync (see Chrome trace: sortSessions hot on
  // every status flip). Output order is byte-identical to the old comparator.
  const keyed = Object.values(sessions)
    .filter((s) => !isSessionHidden(s))
    .map((s) => ({ s, rank: sessionSortRank(s) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
    }
    return a.s._id < b.s._id ? -1 : a.s._id > b.s._id ? 1 : 0;
  });
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

// Prune consumed/stale optimistic sends for a synced session. The conversation
// currently being viewed is left to setMessages (echo-based prune) so a just-sent
// message stays visible in the open thread until its real row syncs in. Failed
// sends are kept (the user may retry them). Returns true if anything changed.
function reconcilePendingSendForSession(
  pendingMessages: Record<string, Message[]>,
  convId: string,
  session: Pick<InboxSession, "agent_status" | "is_idle" | "has_pending" | "updated_at"> | undefined,
  focusedConvId: string | null,
): boolean {
  if (convId === focusedConvId) return false;
  const pending = pendingMessages[convId];
  if (!pending?.length) return false;
  // Protect the LATEST send: don't prune until the server has advanced past it.
  // Legacy entries (persisted before _sentBaselineTs existed) fall back to their
  // own client timestamp.
  let baseline = 0;
  for (const m of pending) {
    if (m._isFailed) continue;
    baseline = Math.max(baseline, m._sentBaselineTs ?? m.timestamp);
  }
  if (!pendingSendConsumed(session, baseline)) return false;
  const kept = pending.filter((m) => m._isFailed);
  if (kept.length === pending.length) return false;
  if (kept.length === 0) delete pendingMessages[convId];
  else pendingMessages[convId] = kept;
  return true;
}

export function isSessionEffectivelyIdle(
  session: Pick<InboxSession, "is_idle" | "agent_status">,
): boolean {
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
  session: Pick<InboxSession, "_id" | "is_idle" | "agent_status" | "message_count" | "is_pinned" | "has_pending" | "awaiting_input" | "is_unresponsive" | "pending_api_error">,
  sessionsWithQueuedMessages?: Set<string>,
): boolean {
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

// Display label used to cluster orchestration workers in the inbox, or null if
// the session isn't a worker. Prefers the PLAN — the reliable, persisted signal
// a worker carries (active_plan, stamped at creation) — and falls back to the
// worktree for an isolated session without a plan. The label doubles as the
// group's identity (plan short_id keeps distinct plans apart).
export function orchestrationGroupLabelOf(s: InboxSession): string | null {
  if (s.active_plan) {
    const title = s.active_plan.title?.trim();
    return title ? `${s.active_plan.short_id} · ${title}` : s.active_plan.short_id;
  }
  const wt = worktreeKeyOf(s);
  return wt ? `⑂ ${wt}` : null;
}

export interface CategorizedSessions {
  sorted: InboxSession[];
  pinned: InboxSession[];
  newSessions: InboxSession[];
  needsInput: InboxSession[];
  working: InboxSession[];
  stashed: InboxSession[];
  dismissed: InboxSession[];
  subsByParent: Map<string, InboxSession[]>;
  forksByParent: Map<string, InboxSession[]>;
  // Top-level worker sessions clustered by plan (or worktree as a fallback),
  // keyed by display label, ≥2 per group. Members are pulled OUT of
  // pinned/new/needsInput/working so the inbox shows one group instead of N
  // loose cards.
  orchestrationGroups: Map<string, InboxSession[]>;
}

export function categorizeSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
  pendingSendIds: ReadonlySet<string> = EMPTY_PENDING_SEND_IDS,
  opts: { currentSessionId?: string | null; pendingCreateIds?: ReadonlySet<string> } = {},
): CategorizedSessions {
  const sorted = sortSessions(sessions);
  const dismissed = Object.values(sessions)
    .filter(isSessionDismissed)
    .sort((a, b) => (b.inbox_dismissed_at || 0) - (a.inbox_dismissed_at || 0));
  const stashed = Object.values(sessions)
    .filter(isSessionStashed)
    .sort((a, b) => (b.inbox_stashed_at || 0) - (a.inbox_stashed_at || 0));
  const allIds = new Set(sorted.map((s) => s._id));

  const subsByParent = new Map<string, InboxSession[]>();
  for (const s of sorted) {
    if (s.parent_conversation_id && allIds.has(s.parent_conversation_id)) {
      if (!subsByParent.has(s.parent_conversation_id)) subsByParent.set(s.parent_conversation_id, []);
      subsByParent.get(s.parent_conversation_id)!.push(s);
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

  // Cluster top-level orchestration workers by plan (or worktree) so a fan-out
  // collapses into one labeled group instead of N loose cards. Only sessions
  // not already nested under a conversation parent and not pinned are eligible;
  // a lone worker (cluster of 1) stays inline. Members are then held out of the
  // flat buckets below via isFlat.
  const orchestrationGroups = new Map<string, InboxSession[]>();
  for (const s of sorted) {
    if (!isTop(s) || s.is_pinned) continue;
    const label = orchestrationGroupLabelOf(s);
    if (!label) continue;
    if (!orchestrationGroups.has(label)) orchestrationGroups.set(label, []);
    orchestrationGroups.get(label)!.push(s);
  }
  for (const [label, members] of Array.from(orchestrationGroups)) {
    if (members.length < 2) orchestrationGroups.delete(label);
  }
  const groupedIds = new Set(
    Array.from(orchestrationGroups.values()).flat().map((s) => s._id),
  );
  // Flat = top-level AND not folded into an orchestration group.
  const isFlat = (s: InboxSession) => isTop(s) && !groupedIds.has(s._id);

  // A pending send is in-flight work just like a locally-queued message: it
  // pushes the session OUT of needs-input and INTO working. Fold the two sets
  // so the existing isSessionWaitingForInput guard handles both with no extra
  // param. A brand-new session (message_count 0) with a pending first message
  // also belongs in Working, not New.
  const inFlight = pendingSendIds.size === 0
    ? sessionsWithQueuedMessages
    : new Set<string>([...sessionsWithQueuedMessages, ...pendingSendIds]);
  const hasPendingSend = (s: InboxSession) => pendingSendIds.has(s._id);
  // Classify waiting-for-input ONCE per session (it's the costliest predicate and
  // was evaluated twice below — in the needsInput and working filters).
  const waitingForInput = new Map<string, boolean>();
  for (const s of sorted) waitingForInput.set(s._id, isSessionWaitingForInput(s, inFlight));

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
    s._id === opts.currentSessionId || !!opts.pendingCreateIds?.has(s._id);
  const newSessions = sorted.filter((s) => s.message_count === 0 && !s.is_pinned && !hasPendingSend(s) && isFlat(s) && isEngagedBlank(s))
    .sort((a, b) => (a.is_connected ? 1 : 0) - (b.is_connected ? 1 : 0));
  const needsInput = sorted.filter((s) => waitingForInput.get(s._id) && isFlat(s))
    .sort((a, b) => {
      // Deferred sessions sink to the bottom of the group; otherwise earliest-updated first.
      if (!!a.is_deferred !== !!b.is_deferred) return a.is_deferred ? 1 : -1;
      return (a.updated_at || 0) - (b.updated_at || 0);
    });
  const working = sorted.filter((s) => (!waitingForInput.get(s._id) && (s.message_count > 0 || hasPendingSend(s)) && !s.is_pinned) && isFlat(s));

  return { sorted, pinned, newSessions, needsInput, working, stashed, dismissed, subsByParent, forksByParent, orchestrationGroups };
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
  } = {},
): InboxSession[] {
  const { pinned, newSessions, needsInput, working, orchestrationGroups } =
    categorizeSessions(sessions, sessionsWithQueuedMessages, pendingSendIds, opts);
  const result: InboxSession[] = [];
  // Orchestration-grouped workers are held out of the flat buckets for the
  // grouped inbox view; append them here so flat-list consumers (keyboard nav,
  // the /sessions list) still see every session.
  const sections = [pinned, newSessions, needsInput, working, ...Array.from(orchestrationGroups.values())];
  for (const section of sections) {
    for (const s of section) {
      if (projectFilter && getProjectName(s.git_root, s.project_path) !== projectFilter) continue;
      if (opts.bucketFilter && opts.bucketByConv?.[s._id] !== opts.bucketFilter) continue;
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
  const visible = sortLabels(buckets);
  const byBucket = new Map<string, InboxSession[]>();
  const byProject = new Map<string, InboxSession[]>();
  const seen = new Set<string>();
  for (const sess of items) {
    if (seen.has(sess._id)) continue;
    seen.add(sess._id);
    const b = bucketByConv[sess._id];
    if (b && buckets[b] && !buckets[b].archived_at) {
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(sess);
    } else {
      const project = getProjectName(sess.git_root, sess.project_path);
      const key = project === "unknown" ? "other" : project;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(sess);
    }
  }
  const byActivity = (a: InboxSession, b: InboxSession) => (b.updated_at ?? 0) - (a.updated_at ?? 0);
  const labelGroups = visible
    .map((bucket) => ({ bucket, items: (byBucket.get(bucket._id) ?? []).sort(byActivity) }))
    .filter((g) => g.items.length > 0);
  const projectGroups = Array.from(byProject.entries())
    .map(([name, list]) => ({ name, items: list.sort(byActivity) }))
    .sort((a, b) =>
      (a.name === "other" ? 1 : 0) - (b.name === "other" ? 1 : 0) || b.items.length - a.items.length);
  return { labelGroups, projectGroups };
}

// Resolve the active inbox view mode from client UI state. Shared by the
// inboxViewMode getter and computeVisualOrder so every consumer agrees on
// which ordering is on screen.
export function resolveInboxViewMode(ui: { inbox_view_mode?: "grouped" | "time" | "bucket"; inbox_flat_view?: boolean } | undefined): "grouped" | "time" | "bucket" {
  return ui?.inbox_view_mode ?? (ui?.inbox_flat_view ? "time" : "grouped");
}

// The session order AS RENDERED: the grouped base order re-shuffled for the
// active view mode (time / by-label). Accepts the live store state or a
// mutative action draft, so keyboard nav (visualOrder) and the dismiss/kill
// advance-to-next paths (hideSessionInDraft, markKilling) all walk exactly
// the list the user is looking at. currentSessionId keeps the blank you're
// sitting on navigable (j/k from a fresh session, dismiss-from-it advances to
// the row below it); all other never-engaged blanks are hidden from the panel
// and so excluded from this order too.
export function computeVisualOrder(state: {
  sessions: Record<string, InboxSession>;
  sessionsWithQueuedMessages: Set<string>;
  activeProjectFilter?: string | null;
  pendingMessages: Record<string, any[]>;
  currentSessionId?: string | null;
  pendingSessionCreates: Record<string, unknown>;
  activeBucketFilter?: string | null;
  bucketAssignments: Record<string, BucketAssignmentItem>;
  buckets: Record<string, BucketItem>;
  clientState: { ui?: { inbox_view_mode?: "grouped" | "time" | "bucket"; inbox_flat_view?: boolean } };
}): InboxSession[] {
  const bucketByConv = convBucketMap(state.bucketAssignments);
  const base = visualOrderSessions(state.sessions, state.sessionsWithQueuedMessages, state.activeProjectFilter, sessionsWithPendingSend(state.pendingMessages), { currentSessionId: state.currentSessionId, pendingCreateIds: new Set(Object.keys(state.pendingSessionCreates)), bucketFilter: state.activeBucketFilter, bucketByConv });
  const mode = resolveInboxViewMode(state.clientState.ui);
  if (mode === "time") {
    return [...base].sort((a, b) => (b.started_at ?? b.updated_at ?? 0) - (a.started_at ?? a.updated_at ?? 0));
  }
  if (mode === "bucket") {
    const pinned = base.filter((s) => s.is_pinned);
    const rest = base.filter((s) => !s.is_pinned);
    const { labelGroups, projectGroups } = groupSessionsForLabelView(rest, state.buckets, bucketByConv);
    return [
      ...pinned,
      ...labelGroups.flatMap((g) => g.items),
      ...projectGroups.flatMap((g) => g.items),
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

interface InboxStoreState {
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
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;
  renamingSessionId: string | null;
  pendingScrollToMessageId: string | null;
  pendingHighlightQuery: string | null;
  showMySessions: boolean;
  setShowMySessions: (show: boolean) => void;
  hiddenSessionCount: number;
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

  currentConversation: CurrentConversationContext;
  isolatedWorktreeMode: boolean;
  setIsolatedWorktreeMode: (val: boolean) => void;

  // -- New session modal --
  newSession: { isOpen: boolean; context: SessionContext };
  openNewSession: (ctx?: SessionContext) => void;
  closeNewSession: () => void;

  // -- Unified command palette --
  palette: { open: boolean; targets: any[]; targetType: 'task' | 'doc' | 'plan' | 'session' | null; initialMode: string; initialQuery?: string };
  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan' | 'session'; mode?: string; initialQuery?: string }) => void;
  closePalette: () => void;
  togglePalette: () => void;

  // -- Create modal --
  createModal: 'task' | 'plan' | 'doc' | null;
  openCreateModal: (type: 'task' | 'plan' | 'doc') => void;
  closeCreateModal: () => void;

  // -- Fork navigation --
  // Forks are first-class conversations; we navigate to them by URL. No overlay state.
  optimisticForkChildren: ForkChild[];

  // -- Dispatch (provided by middleware) --
  _setDispatch: (fn: (action: string, args: any, patches?: any, result?: any) => Promise<any>) => void;
  _setDispatchError: (fn: (action: string, error: unknown, args?: unknown) => void) => void;
  _dispatch: (action: string, args: any, patches?: any, result?: any) => Promise<any>;
  dispatchErrors: number;

  // -- Wrapped actions (middleware creates aliases from do_* -> *) --
  stashSession: (id: string) => void;
  killSession: (id: string) => void;
  killSessions: (ids: string[]) => void;
  markSessionsDismissed: (ids: string[]) => void;
  markBlockedAcknowledged: (ids: string[]) => void;
  applyDismissedReconcile: (entries: { _id: string; inbox_dismissed_at: number | null }[], final: boolean) => void;
  applyStashedReconcile: (entries: { _id: string; inbox_stashed_at: number | null }[], final: boolean) => void;
  restoreSession: (id: string) => void;
  deferSession: (id: string) => void;
  pinSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  switchProject: (convId: string, path: string) => void;
  patchConversation: (id: string, fields: Record<string, any>) => void;
  toggleFavorite: (id: string) => void;
  setPrivacy: (id: string, isPrivate: boolean) => void;
  setTeamVisibility: (id: string, visibility: "summary" | "full" | null) => void;
  toggleBookmark: (conversationId: string, messageId: string) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  sendMessage: (convId: string, content: string, imageIds?: string[], clientId?: string) => void;
  resumeSession: (convId: string) => Promise<any>;
  sendEscape: (convId: string) => void;
  convCommand: (convId: string, command: string, extraArgs?: Record<string, any>, optimistic?: Record<string, any>) => Promise<any>;
  createSession: (opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string }) => Promise<any>;
  // The one true path for optimistically creating a session: stubs a local
  // conversation synchronously and rekeys it to the real Convex id when `create`
  // resolves. Every new-session entry point funnels through this so a first
  // message can never be left non-optimistic. Returns the stub id (navigate to it
  // immediately) and the in-flight create promise (await for the real id).
  // `reuse` makes repeated summons converge on the existing blank session for the
  // same project+agent instead of minting (and pre-warming) a new conversation
  // per summon — see findReusableBlankSession.
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; reuse?: boolean; create: (stubId: string) => Promise<string> }) => { stubId: string; ready: Promise<string> };
  // Verified ghost removal: hard-drop cached session rows the server confirmed
  // deleted (the empty-conversation GC). Plants the exclude pending entries that
  // authorize the IDB row delete and block crawl re-adds.
  pruneGhostSessions: (ids: string[]) => void;
  markServerDeleted: (convId: string) => void;

  // -- Generic sync --
  syncTable: (field: string, incoming: any, opts?: SyncOpts) => void;
  syncRecord: (field: string, id: string, record: any) => void;
  syncOverlay: (field: string, overlayById: Record<string, Record<string, any>>) => void;
  syncMentionIndex: (kind: "tasks" | "docs" | "plans", items: any[]) => void;
  // -- Incremental-sync watermark (IDB-persisted, keyed by "<namespace>:<wsKey>") --
  // The durable memory that makes sync local-first: `cursor` is the highest
  // `updated_at` we've synced for a workspace (the delta channels resume from it
  // instead of re-snapshotting), and `backfilledAt` records when the full
  // reconcile crawl last completed (so it runs once, then incrementally — not a
  // 4,529-row sweep on every launch). See useSyncTasks / reconcileCrawl.
  syncMeta: Record<string, { cursor?: number; backfilledAt?: number }>;
  recordSyncMeta: (key: string, patch: { cursor?: number; backfilledAt?: number }) => void;
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
  setCurrentSession: (id: string, source?: ViewNavSource) => void;
  clearSelection: () => void;
  setShowDismissed: (show: boolean) => void;
  toggleShowDismissed: () => void;
  toggleShowStashed: () => void;
  toggleCollapsedSection: (key: string) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  preloadForkSessions: (forks: ForkChild[], forkedFrom?: string) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  setConversationAgent: (id: string, agentType: string) => void;
  // Local-only optimistic model/effort stamp (header picker / new-session
  // picker). The durable value arrives via the server: rollup echo for
  // in-place switches, reconfigure/create stamps for launches.
  setConversationModel: (id: string, opts: { model?: string | null; effort?: string | null }) => void;
  // In-flight set_model daemon command (ephemeral; not persisted). Set by
  // whichever surface fired the switch (header badge, launch pill, palette);
  // watched by the mounted conversation header, which reverts the optimistic
  // stamp and toasts if the daemon refuses or never answers.
  pendingModelCommand: { convId: string; commandId: string; revert: { model?: string | null; effort?: string | null }; startedAt: number } | null;
  setPendingModelCommand: (cmd: { convId: string; commandId: string; revert: { model?: string | null; effort?: string | null }; startedAt: number } | null) => void;
  navigateToSession: (id: string, source?: ViewNavSource) => void;
  requestNavigate: (
    id: string,
    opts?: {
      scrollToMessageId?: string | null;
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
  setUserMessages: (convId: string, msgs: UserMessage[]) => void;
  addOptimisticMessage: (convId: string, content: string, images?: Array<OptimisticImage>, clientId?: string) => string;
  markOptimisticAsQueued: (convId: string, content: string) => void;
  markOptimisticAsFailed: (convId: string, clientId: string) => void;
  // Swap an optimistic message's still-uploading images for their resolved
  // server records (drops the spinner) once a backgrounded upload completes.
  resolvePendingUploads: (convId: string, clientId: string, images: Array<OptimisticImage>) => void;
  setPagination: (convId: string, update: Partial<PaginationState>) => void;
  initPagination: (convId: string) => void;

  // -- Metadata --
  setCurrentConversation: (ctx: CurrentConversationContext) => void;
  clearCurrentConversation: () => void;

  // -- Drafts --
  setDraft: (id: string, fields: Record<string, any>) => void;
  getDraft: (id: string) => Record<string, any> | undefined;
  moveDraft: (fromId: string, toId: string) => void;
  clearDraft: (id: string) => void;
  clearDraftFinal: (id: string) => void;

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
  saveView: (view: Omit<SavedView, "id" | "created_at" | "team_id">) => void;
  deleteView: (id: string) => void;

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

  // -- Active project scope (non-persisted, resets on reload) --
  activeProjectPath: string | null;
  activeProjectFilter: string | null;
  setActiveProjectFilter: (name: string | null, path?: string | null) => void;

  // -- Manual session buckets --
  buckets: Record<string, BucketItem>;
  bucketAssignments: Record<string, BucketAssignmentItem>;
  // Mutually exclusive with activeProjectFilter: the chip row is ONE filter.
  activeBucketFilter: string | null;
  setActiveBucketFilter: (bucketId: string | null) => void;
  // Panel view mode with back-compat for the pre-bucket inbox_flat_view bool.
  inboxViewMode: () => "grouped" | "time" | "bucket";
  setInboxViewMode: (mode: "grouped" | "time" | "bucket") => void;
  cycleInboxViewMode: () => void;

  // -- Recently visited (sessions, chip views, pages) — newest first --
  recentVisits: RecentVisit[];
  recordRecentVisit: (visit: Omit<RecentVisit, "ts">) => void;
  createBucket: (opts: { name: string; color?: string }) => Promise<{ _id: string }>;
  updateBucket: (id: string, fields: { name?: string; color?: string; sort_order?: number; archived_at?: number | null }) => void;
  assignSessionToBucket: (conversationId: string, bucketId: string | null) => void;

  // -- Sidebar nav expanded sections --
  sidebarNavExpanded: Record<string, boolean>;
  toggleSidebarNav: (section: string) => void;
  // Mark a live subscription's cold-open first-load (see `liveLoading`).
  setLiveLoading: (scope: string, loading: boolean) => void;

  // -- Task / Doc / Plan / Project state --
  tasks: Record<string, TaskItem>;
  taskActiveSessions: Record<string, any>;
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

  // -- Shortcuts panel --
  shortcutsPanelOpen: boolean;
  toggleShortcutsPanel: () => void;

  // -- Settings modal --
  settingsModalSection: SettingsSectionId | null;
  openSettingsModal: (section?: SettingsSectionId) => void;
  closeSettingsModal: () => void;

  // -- Side panel --
  sidePanelSessionId: string | null;
  sidePanelOpen: boolean;
  sidePanelUserClosed: boolean;
  openSidePanel: (sessionId: string) => void;
  closeSidePanel: () => void;
  clearSidePanelSession: () => void;
  toggleSidePanel: () => void;
  selectPanelSession: (sessionId: string | null) => void;

  // -- Task / Doc mutations (action + side effect) --
  updateTaskStatus: (shortId: string, status: string) => Promise<any>;
  updateTask: (shortId: string, fields: { status?: string; priority?: string; title?: string; description?: string; labels?: string[]; triage_status?: string; assignee?: string; execution_status?: string; project_id?: string; project_path?: string }) => Promise<any>;
  createTask: (opts: { title: string; description?: string; task_type?: string; priority?: string; status?: string; project_id?: string; labels?: string[]; assignee?: string; plan_id?: string; team_id?: string; workspace?: string; project_path?: string }) => Promise<any>;
  createDoc: (opts: { title: string; content?: string; doc_type?: string; parent_id?: string; labels?: string[] }) => Promise<any>;
  createPlan: (opts: { title: string; body?: string; goal?: string; acceptance_criteria?: string[]; status?: string; source?: string; project_id?: string; model_stylesheet?: string; fidelity?: string; join_policy?: string; join_k?: number; workspace?: "personal" | "team"; team_id?: string }) => Promise<any>;
  createProject: (opts: { title: string; description?: string; status?: string; color?: string; icon?: string }) => Promise<any>;
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

  // -- Cached query data (local-first) --
  currentUser: any | null;
  teams: any[];
  teamMembers: any[];
  teamUnreadCount: number | null;
  favorites: any[];
  bookmarks: any[];

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

// Max conversations to keep messages in the Zustand store (in-memory).
// Others are evicted but remain in IDB for instant reload.
const MAX_IN_MEMORY_CONVERSATIONS = 50;

function evictInactiveMessages(draft: any, activeConvId: string) {
  const loaded = Object.keys(draft.messages);
  if (loaded.length <= MAX_IN_MEMORY_CONVERSATIONS) return;

  const currentConvId = draft.currentConversation?.conversationId;
  // Never evict conversations actively visible in the UI
  const keep = new Set([activeConvId, currentConvId, draft.currentSessionId, draft.sidePanelSessionId, draft.viewingDismissedId].filter(Boolean));

  // Never evict active inbox sessions — clicking them must be instant
  for (const id of Object.keys(draft.sessions || {})) keep.add(id);

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
  for (const [key, fieldSpec] of Object.entries(spec as Record<string, MergeSpec>)) {
    result[key] = applyMerge(local?.[key], server?.[key], fieldSpec, initialized);
  }
  return result;
}

const SYNC_REGISTRY: Record<string, SyncOpts> = {
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
      "is_connected", "tmux_session", "permission_mode",
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
        );
      }
      if (!draft.currentSessionId && !draft.showMySessions &&
          Object.keys(table).length > 0 && draft.clientStateInitialized &&
          !hasViewNavigated()) {
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
  tasks: { isDelta: true },
  docs: { isDelta: true },
  plans: { isDelta: true },
  // Like the others: a liberal delta cache. useSyncProjects' call site passes no
  // opts, so without this projects synced as an authoritative snapshot — the one
  // remaining collection that still pruned the cache by absence.
  projects: { isDelta: true },
  // altKey supersede for optimistic create-stubs: the incoming server row with
  // the same name rekeys the stub away (names are per-user and practically
  // unique; a rare duplicate-name create just retires the stub onto the older
  // row while the new server row arrives alongside).
  buckets: { isDelta: true, altKey: "name" },
  // Optimistic first-assignments add a local stub row keyed `bucketassign-<convId>`;
  // altKey rekeys that stub onto the server's real (user, conversation) row when
  // it syncs — the same supersede machinery session create-stubs ride.
  bucketAssignments: { isDelta: true, altKey: "conversation_id" },
  clientState: {
    kind: "singleton",
    merge: {
      ui: "local_wins",
      layouts: "local_wins",
      dismissed: mergeStampedBagLww,
      show_dismissed: "local_wins",
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
        draft.tabs = incoming.tabs;
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
  currentUser: { kind: "singleton" },
  teams: { kind: "list" },
  teamMembers: { kind: "list" },
  teamUnreadCount: { kind: "scalar" },
  favorites: { kind: "list" },
  bookmarks: { kind: "list" },
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
}

// Shared body of stashSession/killSession: hide `id` (and its subagent
// children) out of the active buckets, advancing the current selection past the
// removed set. Stash writes inbox_stashed_at; dismiss writes inbox_dismissed_at
// and clears any stash (the row MOVES to Dismissed — the buckets are exclusive).
function hideSessionInDraft(draft: any, id: string, mode: "stash" | "kill") {
  const now = Date.now();
  const field = mode === "kill" ? "inbox_dismissed_at" : "inbox_stashed_at";
  const sessionValues = Object.values(draft.sessions) as InboxSession[];
  const childIds = sessionValues
    .filter((s) => s.parent_conversation_id === id)
    .map((s) => s._id);
  const allIds = [id, ...childIds];
  // The viewer. A session whose user_id isn't ours was injected into this cache
  // by viewing/searching a TEAMMATE's session — we can't durably hide it.
  const me = draft.currentUser?._id?.toString?.();
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
      continue;
    }
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
}

export const useInboxStore = create<InboxStoreState>(
  mutativeMiddleware((set: any, get: any) => ({
  // -- Initial state --
  sessions: {},
  pending: {},
  dispatchErrors: 0,
  currentSessionId: null,
  lastFocusedConversationId: null,
  showDismissed: false,
  collapsedSections: {},
  viewingDismissedId: null,
  pendingNavigateId: null,
  renamingSessionId: null,
  pendingScrollToMessageId: null,
  pendingHighlightQuery: null,
  showMySessions: false,
  setShowMySessions: (show: boolean) => set({ showMySessions: show }),
  hiddenSessionCount: 0,
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

  reviewMessageId: null,
  reviewActiveBlock: 0,
  reviewEditingId: null,
  reviewComments: {},

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

  newSession: { isOpen: false, context: {} },

  openNewSession: (ctx?: SessionContext) => {
    set({ newSession: { isOpen: true, context: ctx || {} } });
  },

  closeNewSession: () => {
    set({ newSession: { isOpen: false, context: {} } });
  },

  palette: { open: false, targets: [], targetType: null, initialMode: 'root' },

  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan' | 'session'; mode?: string; initialQuery?: string }) => {
    set({
      palette: {
        open: true,
        targets: opts?.targets || [],
        targetType: opts?.targetType || null,
        initialMode: opts?.mode || 'root',
        initialQuery: opts?.initialQuery,
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

  createModal: null,
  openCreateModal: (type: 'task' | 'plan' | 'doc') => set({ createModal: type }),
  closeCreateModal: () => set({ createModal: null }),

  optimisticForkChildren: [],
  recentProjects: [],
  setRecentProjects: action(function (this: Draft, projects: Array<{ path: string; count: number; lastActive: number }>) {
    this.recentProjects = projects;
  }),
  activeProjectPath: null,
  activeProjectFilter: null,
  setActiveProjectFilter: action(function (this: Draft, name: string | null, path?: string | null) {
    const prev = snapshotInboxViewFromDraft(this);
    this.activeProjectFilter = name;
    this.activeProjectPath = path ?? null;
    // The chip row is ONE filter: picking a project clears any bucket focus.
    if (name) {
      this.activeBucketFilter = null;
      recordVisitInDraft(this, { kind: "view", key: `project:${name}`, label: name, path: path ?? undefined });
    }
    pushInboxViewHistory(prev, snapshotInboxViewFromDraft(this));
  }),

  // -- Manual session buckets --
  buckets: {},
  bucketAssignments: {},
  activeBucketFilter: null,
  setActiveBucketFilter: action(function (this: Draft, bucketId: string | null) {
    const prev = snapshotInboxViewFromDraft(this);
    this.activeBucketFilter = bucketId;
    if (bucketId) {
      this.activeProjectFilter = null;
      this.activeProjectPath = null;
      recordVisitInDraft(this, { kind: "view", key: `label:${bucketId}`, label: (this.buckets as any)[bucketId]?.name });
    }
    pushInboxViewHistory(prev, snapshotInboxViewFromDraft(this));
  }),
  inboxViewMode: () => resolveInboxViewMode(get().clientState.ui),
  setInboxViewMode: (mode: "grouped" | "time" | "bucket") => {
    const state = get();
    const prev = snapshotInboxViewFromDraft(state);
    // inbox_flat_view stays coherent so existing flat-view readers keep working.
    state.updateClientUI({ inbox_view_mode: mode, inbox_flat_view: mode === "time" });
    pushInboxViewHistory(prev, snapshotInboxViewFromDraft(get()));
  },
  cycleInboxViewMode: () => {
    const state = get();
    const current = state.inboxViewMode();
    const hasBuckets = (Object.values(state.buckets) as BucketItem[]).some((b) => !b.archived_at);
    const cycle: Array<"grouped" | "time" | "bucket"> = hasBuckets ? ["grouped", "time", "bucket"] : ["grouped", "time"];
    state.setInboxViewMode(cycle[(cycle.indexOf(current) + 1) % cycle.length]);
  },

  recentVisits: [],
  recordRecentVisit: sync(function (this: Draft, visit: Omit<RecentVisit, "ts">) {
    recordVisitInDraft(this, visit);
  }),

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  // Stash = set aside WITHOUT killing (Stashed bucket, agent keeps running).
  stashSession: action(function (this: Draft, id: string) {
    soundDismiss();
    hideSessionInDraft(this, id, "stash");
  }),

  // Kill = done with it. The server tears the agent down on the hide data
  // transition (dispatch.applyPatches sees inbox_dismissed_at flip), so this
  // action only has to move the rows; every kill path gets the teardown
  // without remembering to ask for it. (The persisted field keeps its
  // historical name inbox_dismissed_at; the UI calls the bucket "Killed".)
  killSession: action(function (this: Draft, id: string) {
    soundKill();
    hideSessionInDraft(this, id, "kill");
  }),

  // Bulk kill ("Kill all" on the Stashed bucket): one action so the patches
  // ride a single dispatch and the kill sound plays once, not N times. Scale
  // is the user-curated stash list (tens) — each row NEEDS its own server
  // patch anyway (the per-conversation hide transition is what enqueues the
  // agent teardown), so the markSessionsDismissed storm concern doesn't apply.
  killSessions: action(function (this: Draft, ids: string[]) {
    if (ids.length === 0) return;
    soundKill();
    for (const id of ids) hideSessionInDraft(this, id, "kill");
  }),

  // Bulk-dismiss a precomputed set of sessions locally (instant, optimistic). A
  // sync() — NOT action() — on purpose: action() auto-dispatches one server patch
  // per mutated conversation, so dismissing thousands would be a dispatch storm.
  // The caller persists authoritatively with ONE paginated server mutation
  // (conversations.dismissStaleInboxSessions) instead. Skips already-dismissed
  // rows. Used by the "dismiss old sessions" inbox prompt.
  markSessionsDismissed: sync(function (this: Draft, ids: string[]) {
    const now = Date.now();
    for (const id of ids) {
      const sess = this.sessions[id];
      if (sess && !sess.inbox_dismissed_at) sess.inbox_dismissed_at = now;
      if (this.conversations[id] && !(this.conversations[id] as any).inbox_dismissed_at) {
        (this.conversations[id] as any).inbox_dismissed_at = now;
      }
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
      }
      const conv = this.conversations[id] as any;
      if (conv) {
        conv.pending_api_error = false;
        conv.pending_api_error_kind = null;
      }
    }
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
    for (const id of ids) {
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
  // active inbox. Clears BOTH hide flags — un-hiding is un-hiding.
  restoreSession: action(function (this: Draft, id: string) {
    const childIds = Object.values(this.sessions as Record<string, InboxSession>)
      .filter((s) => isSessionHidden(s) && s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    for (const sid of allIds) {
      if (this.sessions[sid]) {
        this.sessions[sid].inbox_dismissed_at = null;
        this.sessions[sid].inbox_stashed_at = null;
      }
      const conv = this.conversations[sid] as any;
      if (conv) {
        conv.inbox_dismissed_at = null;
        conv.inbox_stashed_at = null;
      }
    }
    declareViewNav("gesture");
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    recordCurrentConversationPointer(this, id);
  }),

  deferSession: action(function (this: Draft, id: string) {
    if (this.sessions[id]) this.sessions[id].is_deferred = true;
    if (this.conversations[id]) (this.conversations[id] as any).inbox_deferred_at = Date.now();
  }),

  pinSession: action(function (this: Draft, id: string) {
    const newPinned = !this.sessions[id]?.is_pinned;
    const pinnedAt = newPinned ? Date.now() : null;
    if (this.sessions[id]) {
      this.sessions[id].is_pinned = newPinned;
      this.sessions[id].inbox_pinned_at = pinnedAt;
    }
    if (this.conversations[id]) {
      (this.conversations[id] as any).inbox_pinned_at = pinnedAt;
      if (newPinned) (this.conversations[id] as any).inbox_killed_at = undefined;
    }
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
  }),

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
    if (idx !== -1) list.splice(idx, 1);
    else list.push({ _id: `temp_${Date.now()}`, conversation_id: conversationId, message_id: messageId, created_at: Date.now() });
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
    // No local mutation here: durability for the visible message comes from the
    // persisted pendingMessages map. This body exists only so the middleware
    // dispatches the args to the server and queues them in the outbox.
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

  createSession: asyncAction(function (this: Draft, opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string }) {
    const sessionId = opts.session_id || (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    if (!opts.session_id) opts.session_id = sessionId;
    const now = Date.now();
    this.sessions[sessionId] = {
      _id: sessionId,
      session_id: sessionId,
      title: "New session",
      updated_at: now,
      started_at: now,
      project_path: opts.project_path,
      git_root: opts.git_root,
      agent_type: opts.agent_type,
      message_count: 0,
      is_idle: true,
      has_pending: false,
      last_user_message: null,
    } as InboxSession;
  }),

  // Optimistic session creation, shared by every new-session entry point (the
  // in-app quick-create, the compose popup, and the New Session modal). Seeds a
  // local conversation under a non-Convex stub id SYNCHRONOUSLY so the caller can
  // navigate to it and render the user's first message as pending with zero
  // network in the critical path, then rekeys stub → real id when `create`
  // resolves. `create` is injected so callers pick the backend (store.createSession
  // for normal sessions, the createQuickSession mutation when isolated/worktree
  // options are needed). The stub uses the same Math.random id scheme as
  // createSession — never 32 chars, so isConvexId() correctly treats it as local.
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; reuse?: boolean; create: (stubId: string) => Promise<string> }) => {
    const store = get();
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
        const bucketAtCreate = store.activeBucketFilter;
        if (bucketAtCreate) {
          ready.then((id: string) => {
            const real = get().getConvexId(id) ?? id;
            if (isConvexId(real) && !convBucketMap(get().bucketAssignments)[real]) {
              get().assignSessionToBucket(real, bucketAtCreate);
            }
          }).catch(() => {});
        }
        return { stubId: existing, ready };
      }
    }
    const stubId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    store.syncRecord("conversations", stubId, {
      _id: stubId, _creationTime: now, user_id: "", agent_type: opts.agentType,
      session_id: stubId, project_path: opts.projectPath, git_root: opts.gitRoot,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [],
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
    });
    // Capture the focused bucket NOW: a session created while a bucket chip is
    // active belongs to that bucket. Assignment waits for the real id (the
    // server side effect can't act on stubs).
    const bucketAtCreate = store.activeBucketFilter;
    const ready = opts.create(stubId).then((convexId: string) => {
      if (convexId) {
        store.resolveSessionId(stubId, convexId);
        if (bucketAtCreate && isConvexId(convexId)) {
          get().assignSessionToBucket(convexId, bucketAtCreate);
        }
      }
      return convexId;
    });
    store.trackSessionCreate(stubId, ready);
    // Callers attach their own handling; swallow here so an unobserved create
    // failure doesn't surface as an unhandled rejection.
    ready.catch(() => {});
    return { stubId, ready };
  },

  _applyClientUI: sync(function (this: Draft, partial: Partial<ClientUI>) {
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    Object.assign(this.clientState.ui, partial);
  }),

  updateClientUI: (partial: Partial<ClientUI>) => {
    (get() as any)._applyClientUI(partial);
    writeCriticalUiPrefs(partial as Record<string, any>);
    if (Object.keys(partial).length > 0) {
      const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { ui: partial } } });
      dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
    }
  },

  _applySavedViews: sync(function (this: Draft, views: SavedView[]) {
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    this.clientState.ui.saved_views = views;
  }),

  saveView: (view: Omit<SavedView, "id" | "created_at" | "team_id">) => {
    const state = get();
    const current = state.clientState.ui?.saved_views ?? [];
    const newView: SavedView = {
      ...view,
      id: `sv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      team_id: state.clientState.ui?.active_team_id,
      created_at: Date.now(),
    };
    const newViews = [...current, newView];
    (state as any)._applySavedViews(newViews);
    const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { ui: { saved_views: newViews } } } });
    dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
  },

  deleteView: (id: string) => {
    const state = get();
    const current = state.clientState.ui?.saved_views ?? [];
    const newViews = current.filter((v: SavedView) => v.id !== id);
    (state as any)._applySavedViews(newViews);
    const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { ui: { saved_views: newViews } } } });
    dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
  },

  _applyClientLayout: sync(function (this: Draft, key: string, value: any) {
    if (!this.clientState.layouts) this.clientState.layouts = {};
    (this.clientState.layouts as any)[key] = value;
  }),

  updateClientLayout: (key: string, value: any) => {
    (get() as any)._applyClientLayout(key, value);
    const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { layouts: { [key]: value } } } });
    dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
  },

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
      const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { tips: serverPartial } } });
      dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
    }
  },

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
  // sorted newest-first. Bounded only to keep the persisted blob sane. sync() =
  // local draft + IDB write, no server dispatch.
  mergeFeedConversations: sync(function (this: Draft, key: string, convs: any[]) {
    const byId = new Map((this.feedConversations[key] ?? []).map((c: any) => [c._id, c]));
    for (const c of convs ?? []) byId.set(c._id, c);
    this.feedConversations[key] = [...byId.values()]
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 2000);
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
  recordSyncMeta: sync(function (this: Draft, key: string, patch: { cursor?: number; backfilledAt?: number }) {
    const prev = this.syncMeta[key] ?? {};
    const next = { ...prev };
    if (typeof patch.cursor === "number" && patch.cursor > (prev.cursor ?? 0)) next.cursor = patch.cursor;
    if (typeof patch.backfilledAt === "number") next.backfilledAt = patch.backfilledAt;
    this.syncMeta[key] = next;
  }),

  syncTable: sync(function (this: Draft, field: string, incoming: any, opts?: SyncOpts) {
    if (!incoming && incoming !== 0) return;
    const config = SYNC_REGISTRY[field] ? { ...SYNC_REGISTRY[field], ...opts } : (opts || {});
    const kind = config.kind ?? "collection";

    if (kind === "scalar" || kind === "list") {
      (this as any)[field] = incoming;
      if (config.transform) config.transform(this, incoming, incoming, false);
      if (config.extra) Object.assign(this, config.extra);
      return;
    }

    if (kind === "singleton") {
      const local = (this as any)[field];
      const initKey = `${field}Initialized`;
      const initialized = (this as any)[initKey] ?? false;
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
    const prevCollection = (this as any)[field] || {};
    const { table, pending } = applySyncTable(
      field, incoming, this.pending, prevCollection,
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
      const incomingByAlt = new Map(
        (incoming as any[]).map((r: any) => [r[config.altKey!], r])
      );
      for (const [oldId, old] of Object.entries(prevCollection)) {
        if (isConvexId(oldId)) continue;
        const match = incomingByAlt.get((old as any)[config.altKey!] || oldId);
        if (match) {
          rekeyId(this, oldId, match._id);
          rekeyPending(pending, oldId, match._id);
          if (oldId !== match._id && table[oldId]) {
            if (!table[match._id]) {
              table[match._id] = { ...(table[oldId] as any), _id: match._id };
            }
            delete table[oldId];
          }
          // Reapply field overrides that applySyncTable missed (it ran
          // before the pending entries were rekeyed to the new ID).
          const fp = `${field}:${match._id}:`;
          for (const [key, entry] of Object.entries(pending)) {
            if (entry.type !== "field" || !key.startsWith(fp)) continue;
            if (table[match._id]) {
              (table[match._id] as any)[key.slice(fp.length)] = entry.value;
            }
          }
        } else if (!table[oldId]) {
          table[oldId] = old as any;
        }
      }
    }

    if (config.keepSelected) {
      const selectedId = (this as any)[config.keepSelected];
      if (selectedId && !table[selectedId] && prevCollection[selectedId]) {
        table[selectedId] = prevCollection[selectedId];
      }
    }

    if (!config.altKey && !config.extra && !config.transform) {
      if (prevCollection) {
        const newKeys = Object.keys(table);
        if (newKeys.length === Object.keys(prevCollection).length &&
            newKeys.every(k => prevCollection[k]?.updated_at === (table[k] as any)?.updated_at)) {
          return;
        }
      }
    }

    (this as any)[field] = table;
    this.pending = pending as any;
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
    const ordered = get().visualOrder();
    if (ordered.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = ordered.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = (idx - 1 + ordered.length) % ordered.length;
    get().navigateToSession(ordered[newIdx]._id);
  },

  navigateDown: () => {
    const ordered = get().visualOrder();
    if (ordered.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = ordered.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = (idx + 1) % ordered.length;
    get().navigateToSession(ordered[newIdx]._id);
  },

  setCurrentSession: action(function (this: Draft, id: string, source: ViewNavSource = "gesture") {
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
    recordSessionView(this, id, this.currentSessionId);
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    recordCurrentConversationPointer(this, id);
  }),

  clearSelection: action(function (this: Draft) {
    this.viewingDismissedId = null;
  }),

  setShowDismissed: action(function (this: Draft, show: boolean) {
    this.clientState.show_dismissed = show;
  }),

  // Both hidden buckets are CLOSED by default (unset/undefined = closed):
  // open only while the flag is explicitly true.
  toggleShowDismissed: action(function (this: Draft) {
    this.clientState.show_dismissed = this.clientState.show_dismissed !== true;
  }),

  toggleShowStashed: action(function (this: Draft) {
    this.clientState.show_stashed = this.clientState.show_stashed !== true;
  }),

  toggleCollapsedSection: action(function (this: Draft, key: string) {
    this.collapsedSections = { ...this.collapsedSections, [key]: !this.collapsedSections[key] };
  }),

  setViewingDismissedId: action(function (this: Draft, id: string | null) {
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
    this.sessions[session._id] = { ...session };
    if (isSessionHidden(session)) {
      this.viewingDismissedId = session._id;
    } else {
      declareViewNav("gesture");
      recordSessionView(this, session._id, this.currentSessionId);
      this.currentSessionId = session._id;
      this.viewingDismissedId = null;
      recordCurrentConversationPointer(this, session._id);
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
      if (this.sessions[id]) continue;                    // don't clobber live data
      if (this.pending[`sessions:${id}`]?.type === "exclude") continue; // killed locally
      if (!this.conversations[id]) this.conversations[id] = { _id: id } as any;
      this.sessions[id] = {
        _id: id,
        session_id: id,
        title: f.title,
        updated_at: f.updated_at ?? f.started_at ?? Date.now(),
        started_at: f.started_at,
        agent_type: f.agent_type || "claude_code",
        message_count: f.message_count ?? 0,
        is_idle: true,
        has_pending: false,
        forked_from: forkedFrom ?? null,
        parent_message_uuid: f.parent_message_uuid ?? null,
      } as InboxSession;
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

  pendingModelCommand: null,
  setPendingModelCommand: (cmd: { convId: string; commandId: string; revert: { model?: string | null; effort?: string | null }; startedAt: number } | null) => set({ pendingModelCommand: cmd }),

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
    declareViewNav(source);
    const session = this.sessions[id];
    if (session) {
      if (isSessionHidden(session)) {
        this.viewingDismissedId = id;
      } else {
        recordSessionView(this, id, this.currentSessionId);
        this.currentSessionId = id;
        this.viewingDismissedId = null;
        recordCurrentConversationPointer(this, id);
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
      highlightQuery?: string | null;
      showMySessions?: boolean;
      source?: ViewNavSource;
    },
  ) {
    declareViewNav(opts?.source ?? "gesture");
    this.pendingNavigateId = id;
    if (opts && "scrollToMessageId" in opts) this.pendingScrollToMessageId = opts.scrollToMessageId ?? null;
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
    declareViewNav("gesture");
    this.currentSessionId = newSessionId;
    recordCurrentConversationPointer(this, newSessionId ?? undefined);
  }),


  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: sync(function (this: Draft, convId: string, msgs: Message[], meta?: Partial<PaginationState>) {
    msgs = dedupeReplayedMessages(msgs);
    // Prune confirmed messages from pendingMessages
    const pending = this.pendingMessages[convId] || [];
    if (pending.length > 0) {
      const serverUserMsgs = msgs.filter((m: Message) => m.role === "user");
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
      // Only reassign when something was actually pruned. The filter is a
      // remove-only pass, so equal length means identical contents — keeping
      // the old reference avoids churning pendingMessages identity on every
      // streaming tick while a send is in-flight (defeats SessionCard memo).
      if (kept.length !== pending.length) {
        this.pendingMessages[convId] = kept;
      }
    }
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

  resolvePendingUploads: sync(function (this: Draft, convId: string, clientId: string, images: Array<OptimisticImage>) {
    const pending = this.pendingMessages[convId];
    if (!pending) return;
    this.pendingMessages[convId] = pending.map((m) =>
      m._clientId === clientId || m._id === clientId ? { ...m, images } : m
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
  }),

  clearDraftFinal: (id: string) => {
    get().clearDraft(id);
    get()._dispatch("clearDraft", [id], {
      client_state: { _: { drafts: { [id]: null } } },
    }).catch(() => {});
  },

  // =====================
  // SESSION ID RESOLUTION
  // =====================

  _rekeySession: sync(function (this: Draft, sessionId: string, convexId: string) {
    rekeyPending(this.pending, sessionId, convexId);
    rekeyId(this, sessionId, convexId);
  }),

  resolveSessionId: (sessionId: string, convexId: string) => {
    (get() as any)._rekeySession(sessionId, convexId);
    // Flush pending field changes to server. Fields modified while the
    // session had a stub ID weren't dispatched (groupPatchesByTable
    // skips non-Convex IDs), so send them now.
    const state = get();
    const prefix = `conversations:${convexId}:`;
    const fields: Record<string, any> = {};
    for (const [key, entry] of Object.entries(state.pending || {})) {
      if ((entry as any).type !== "field" || !key.startsWith(prefix)) continue;
      fields[key.slice(prefix.length)] = (entry as any).value;
    }
    if (Object.keys(fields).length > 0) {
      (state as any)._dispatch("patch", [], { conversations: { [convexId]: fields } }).catch(() => {});
    }
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
    promise.finally(() => {
      set((s: InboxStoreState) => {
        if (!s.pendingSessionCreates[stubId]) return s;
        const { [stubId]: _, ...rest } = s.pendingSessionCreates;
        return { pendingSessionCreates: rest };
      });
    });
  },

  awaitSessionCreate: (stubId: string) => {
    return get().pendingSessionCreates[stubId];
  },

  awaitConvexId: async (id: string): Promise<string> => {
    const resolved = get().getConvexId(id);
    if (resolved) return resolved;
    // Prefer the in-flight createSession promise — deterministic and surfaces
    // the real dispatch error if the server rejects. Polling is the fallback
    // for cases where the promise was lost (e.g. reload mid-flight) or the
    // rekey arrives via listInboxSessions altKey sync instead of the dispatch.
    const inFlight = get().awaitSessionCreate(id);
    if (inFlight) {
      let createError: unknown = null;
      try {
        const convexId = await Promise.race([
          inFlight,
          new Promise<string>((_, rej) => setTimeout(() => rej(new Error("create timeout")), 30_000)),
        ]);
        if (convexId) return convexId;
      } catch (e) {
        createError = e;
      }
      const r2 = get().getConvexId(id);
      if (r2) return r2;
      if (createError) throw createError instanceof Error ? createError : new Error(String(createError));
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const r = get().getConvexId(id);
      if (r) return r;
    }
    throw new Error("Session not yet created on server");
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
    // currentSessionId, …) — the fork stub is navigated to immediately, so every
    // pointer the new-session stub convention moves must move here too.
    (get() as any)._rekeySession(sessionId, convexId);
    const state = get();
    const newOptimistic = state.optimisticForkChildren.map((f: ForkChild) =>
      f._id === sessionId ? { ...f, _id: convexId } : f
    );
    set({ optimisticForkChildren: newOptimistic });
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
  setLiveLoading: (scope: string, loading: boolean) => set((s: any) => ({
    liveLoading: { ...s.liveLoading, [scope]: loading },
  })),

  tasks: {},
  taskActiveSessions: {} as Record<string, any>,
  syncProgress: {},
  liveLoading: {},
  mentionIndex: { tasks: {}, docs: {}, plans: {} },
  docs: {},
  plans: {},
  projects: {},
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

  updateTaskStatus: action(function (this: Draft, shortId: string, status: string) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as TaskItem | undefined;
    if (task) {
      task.status = status;
      task.updated_at = Date.now();
      if (status === "done" || status === "dropped") {
        (task as any).closed_at = Date.now();
      }
    }
  }),

  updateTask: action(function (this: Draft, shortId: string, fields: Record<string, any>) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as TaskItem | undefined;
    if (task) {
      Object.assign(task, fields, { updated_at: Date.now() });
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

  createTask: action(function (this: Draft, opts: any) {
    const tempId = `temp_${Date.now()}`;
    const tempShortId = `ct-new`;
    this.tasks[tempId] = {
      _id: tempId,
      short_id: tempShortId,
      title: opts.title,
      description: opts.description,
      task_type: opts.task_type || "task",
      status: opts.status || "open",
      priority: opts.priority || "medium",
      source: "human",
      labels: opts.labels,
      created_at: Date.now(),
      updated_at: Date.now(),
    } as TaskItem;
  }),

  // Creates route through the single dispatch path (no direct useMutation) and
  // delegate to the existing webCreate mutation, which returns the real id. We
  // intentionally do NOT add an optimistic stub: every caller awaits the result
  // and navigates to the new record's own page, and delta-synced lists don't
  // prune, so a temp stub would linger as a duplicate. asyncAction surfaces the
  // server result so `const r = await createDoc(...); router.push(r.id)` works.
  createDoc: asyncAction(function (this: Draft, _opts: Record<string, any>) {}),
  createPlan: asyncAction(function (this: Draft, _opts: Record<string, any>) {}),
  createProject: asyncAction(function (this: Draft, _opts: Record<string, any>) {}),

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
  createBucket: asyncAction(function (this: Draft, opts: { name: string; color?: string }) {
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
  }),

  // Rename / color / sort / archive ride the generic patch path (inbox_buckets
  // is in dispatch TABLE_CONFIG); fields are auto-protected until server echo.
  updateBucket: action(function (this: Draft, id: string, fields: { name?: string; color?: string; sort_order?: number; archived_at?: number | null }) {
    const bucket = this.buckets[id] as any;
    if (!bucket) return;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      bucket[k] = v === null ? undefined : v;
    }
    bucket.updated_at = Date.now();
  }),

  // Exclusive filing: upsert the one assignment row for this conversation.
  // First-time assignments add a stub row; the bucketAssignments altKey config
  // rekeys it onto the server row when it syncs. The same-named dispatch side
  // effect performs the durable upsert. A stub conversation id is allowed when
  // the server reaches the same assignment on its own (fork label inheritance):
  // the dispatch no-ops there, and rekeyId carries the local row to the real id.
  assignSessionToBucket: action(function (this: Draft, conversationId: string, bucketId: string | null) {
    const now = Date.now();
    const existing = (Object.values(this.bucketAssignments) as BucketAssignmentItem[])
      .find(a => a.conversation_id === conversationId);
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
    if (task?.comments) {
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

  // =====================
  // MESSAGE QUEUE
  // =====================

  sessionsWithQueuedMessages: new Set<string>(),
  setSessionHasQueuedMessages: (sessionId: string, hasQueued: boolean) => {
    const prev = get().sessionsWithQueuedMessages;
    const next = new Set(prev);
    if (hasQueued) next.add(sessionId);
    else next.delete(sessionId);
    set({ sessionsWithQueuedMessages: next });
  },

  // SIDE PANEL
  // =====================

  shortcutsPanelOpen: false,
  toggleShortcutsPanel: () => set({ shortcutsPanelOpen: !get().shortcutsPanelOpen }),

  settingsModalSection: null,
  openSettingsModal: (section?: SettingsSectionId) =>
    set({ settingsModalSection: section ?? DEFAULT_SETTINGS_SECTION }),
  closeSettingsModal: () => set({ settingsModalSection: null }),

  sidePanelSessionId: null,
  sidePanelOpen: false,
  sidePanelUserClosed: false,

  openSidePanel: action(function (this: Draft, sessionId: string) {
    this.sidePanelSessionId = sessionId;
    this.sidePanelOpen = true;
    this.sidePanelUserClosed = false;
  }),

  closeSidePanel: action(function (this: Draft) {
    this.sidePanelSessionId = null;
    this.sidePanelOpen = false;
  }),

  clearSidePanelSession: action(function (this: Draft) {
    this.sidePanelSessionId = null;
  }),

  toggleSidePanel: action(function (this: Draft) {
    if (this.sidePanelOpen) {
      this.sidePanelOpen = false;
      this.sidePanelUserClosed = true;
    } else {
      this.sidePanelOpen = true;
      this.sidePanelUserClosed = false;
      this.sidePanelSessionId = this.sidePanelSessionId ?? this.currentSessionId ?? null;
    }
  }),

  selectPanelSession: action(function (this: Draft, sessionId: string | null) {
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
    const id = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tab: AppTab = {
      id,
      title: opts.title,
      path: opts.path,
      sessionId: opts.sessionId,
      sidePanelSessionId: this.sidePanelSessionId ?? undefined,
      sidePanelOpen: this.sidePanelOpen || undefined,
      sidePanelUserClosed: this.sidePanelUserClosed || undefined,
      createdAt: Date.now(),
    };
    this.tabs = [...this.tabs, tab];
    if (opts.makeActive !== false) this.activeTabId = id;
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
      const conv = nextTab?.path.match(/^\/conversation\/([^/?#]+)$/);
      if (conv) {
        newTabs = newTabs.map((t: AppTab) =>
          t.id === nextTab.id ? { ...t, path: `/inbox?s=${conv[1]}` } : t,
        );
      }
    }
    this.tabs = newTabs;
  }),

  switchTab: action(function (this: Draft, id: string) {
    if (this.activeTabId === id) return;
    if (this.activeTabId) {
      this.tabs = this.tabs.map((t: AppTab) => t.id === this.activeTabId ? {
        ...t,
        sidePanelSessionId: this.sidePanelSessionId ?? undefined,
        sidePanelOpen: this.sidePanelOpen || undefined,
        sidePanelUserClosed: this.sidePanelUserClosed || undefined,
        path: typeof window !== "undefined" ? window.location.pathname : t.path,
      } : t);
    }
    const target = this.tabs.find((t: AppTab) => t.id === id);
    this.activeTabId = id;
    if (target) {
      this.sidePanelSessionId = target.sidePanelSessionId ?? null;
      this.sidePanelOpen = target.sidePanelOpen ?? false;
      this.sidePanelUserClosed = target.sidePanelUserClosed ?? false;
    }
  }),

  updateTab: action(function (this: Draft, id: string, patch: Partial<AppTab>) {
    const current = this.tabs.find((t: AppTab) => t.id === id);
    if (!current) return;
    let changed = false;
    for (const k in patch) {
      if ((current as any)[k] !== (patch as any)[k]) { changed = true; break; }
    }
    if (!changed) return;
    this.tabs = this.tabs.map((t: AppTab) => t.id === id ? { ...t, ...patch } : t);
  }),

  saveCurrentTabState: action(function (this: Draft, patch?: Partial<AppTab>) {
    if (!this.activeTabId) return;
    this.tabs = this.tabs.map((t: AppTab) => t.id === this.activeTabId ? {
      ...t,
      sidePanelSessionId: this.sidePanelSessionId ?? undefined,
      sidePanelOpen: this.sidePanelOpen || undefined,
      sidePanelUserClosed: this.sidePanelUserClosed || undefined,
      path: typeof window !== "undefined" ? window.location.pathname : t.path,
      ...patch,
    } : t);
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

  // =====================
  // SELECTORS
  // =====================

  getSession: (id: string) => {
    return get().sessions[id];
  },

})) as any);

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
    prevRef.current = { deps: next, state };
    return state;
  });
}

// -- Per-conversation IDB hydration (idempotent, no hooks) --
// Tracks in-flight hydrations (not "ever hydrated") so evicted conversations
// can be re-hydrated from IDB when the user switches back to them.
const _idbHydratingSet = new Set<string>();
export function ensureHydrated(convId: string) {
  const store = useInboxStore.getState();
  // Already in memory — nothing to hydrate
  if (store.messages[convId]?.length > 0) return;
  // In-flight hydration — don't double-load
  if (_idbHydratingSet.has(convId)) return;
  _idbHydratingSet.add(convId);
  loadConversationMessages(convId).then((cached) => {
    _idbHydratingSet.delete(convId);
    if (!cached || cached.messages.length === 0) return;
    const current = useInboxStore.getState().messages[convId];
    if (current?.length > 0) return;
    useInboxStore.getState().setMessages(convId, cached.messages, cached.pagination);
  });
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

if (PERSISTENCE_AVAILABLE) {
  (useInboxStore.getState() as any)._setIDBWrite(writePatchesToIDB);
  (useInboxStore.getState() as any)._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);

  setHydrating(true);
  void loadCache().then((cached) => {
    if (!cached) {
      setHydrating(false);
      useInboxStore.setState({ clientStateInitialized: true });
      return;
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
              if (uv != null && (curUI as any)[uk] == null) uiPatch[uk] = uv;
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

    // Preload messages for all active inbox sessions so clicks are instant
    for (const id of Object.keys(cached.sessions || {})) {
      ensureHydrated(id);
    }

    // Deferred: list views + secondary data hydrate just after first paint.
    // setTimeout, NOT requestAnimationFrame: rAF is paused in background tabs, so
    // with the gate release below tied to it, a backgrounded tab would never
    // finish hydrating and never re-enable IDB writes (stuck `_hydrating`). With
    // the user running many session tabs, most are backgrounded — they must still
    // hydrate and persist. setTimeout fires (throttled) even when hidden.
    setTimeout(() => {
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
    }, 0);
  });
} else {
  // No native persistence (ExpoSQLite module absent on this binary — e.g. an OTA
  // landed on an app built before expo-sqlite was added). Skip hydration and
  // write-through wiring entirely and run in-memory, but still release the init
  // gate so the app renders against a fresh empty store instead of hanging.
  useInboxStore.setState({ clientStateInitialized: true });
}
