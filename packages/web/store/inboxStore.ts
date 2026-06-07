import { create } from "zustand";
import { useSyncExternalStore, useRef } from "react";
import { mutativeMiddleware, action, asyncAction, sync } from "./mutativeMiddleware";
import { applySyncTable, applySyncRecord, type PendingEntry } from "./syncProtocol";
import { soundDismiss, soundKill } from "../lib/sounds";
import { loadCache, writePatchesToIDB, setHydrating, loadConversationMessages, writeConversationMessages, enqueueDispatch, removeDispatch, loadOutbox, PERSISTENCE_AVAILABLE } from "./idbCache";

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
import { deriveDocDisplayTitle } from "../lib/liveEntities";
import type { PendingComment } from "../lib/quoteFormat";

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
  agent_status?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming";
  tmux_session?: string | null;
  permission_mode?: string | null;
  is_deferred?: boolean;
  is_pinned?: boolean;
  // When the user pinned this session (Date.now() ms). Drives a stable order in
  // the Pinned group so cards don't reshuffle on agent status churn.
  inbox_pinned_at?: number | null;
  inbox_dismissed_at?: number | null;
  last_user_message?: string | null;
  session_error?: string;
  // True when the session's latest turn is an unresolved Claude Code auth/API
  // error banner ("Please run /login · API Error: 401 …") — the CLI was signed
  // out / rate-limited mid-turn and is parked waiting on the user to
  // re-authenticate or retry. Surfaced by the server; routes the row to
  // needs-input and shows a distinct "login" badge. Self-clears when a real
  // turn supersedes the banner.
  pending_api_error?: boolean;
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
  // Inbox session panel view mode. When true, the panel drops the
  // Pinned/New/Needs-Input/Working grouping and shows every session as one flat
  // list sorted newest-first by creation time (started_at). Toggled by Ctrl+,.
  inbox_flat_view?: boolean;
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
    .filter((s) => !isSessionDismissed(s))
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

const ACTIVE_AGENT_STATUSES: Set<string> = new Set(["working", "compacting", "thinking", "connected", "starting", "resuming"]);
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
): CategorizedSessions {
  const sorted = sortSessions(sessions);
  const dismissed = Object.values(sessions)
    .filter(isSessionDismissed)
    .sort((a, b) => (b.inbox_dismissed_at || 0) - (a.inbox_dismissed_at || 0));
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
  const newSessions = sorted.filter((s) => s.message_count === 0 && !s.is_pinned && !hasPendingSend(s) && isFlat(s))
    .sort((a, b) => (a.is_connected ? 1 : 0) - (b.is_connected ? 1 : 0));
  const needsInput = sorted.filter((s) => waitingForInput.get(s._id) && isFlat(s))
    .sort((a, b) => {
      // Deferred sessions sink to the bottom of the group; otherwise earliest-updated first.
      if (!!a.is_deferred !== !!b.is_deferred) return a.is_deferred ? 1 : -1;
      return (a.updated_at || 0) - (b.updated_at || 0);
    });
  const working = sorted.filter((s) => (!waitingForInput.get(s._id) && (s.message_count > 0 || hasPendingSend(s)) && !s.is_pinned) && isFlat(s));

  return { sorted, pinned, newSessions, needsInput, working, dismissed, subsByParent, forksByParent, orchestrationGroups };
}

export function visualOrderSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
  projectFilter?: string | null,
  pendingSendIds: ReadonlySet<string> = EMPTY_PENDING_SEND_IDS,
): InboxSession[] {
  const { pinned, newSessions, needsInput, working, orchestrationGroups } =
    categorizeSessions(sessions, sessionsWithQueuedMessages, pendingSendIds);
  const result: InboxSession[] = [];
  // Orchestration-grouped workers are held out of the flat buckets for the
  // grouped inbox view; append them here so flat-list consumers (keyboard nav,
  // the /sessions list) still see every session.
  const sections = [pinned, newSessions, needsInput, working, ...Array.from(orchestrationGroups.values())];
  for (const section of sections) {
    for (const s of section) {
      if (projectFilter && getProjectName(s.git_root, s.project_path) !== projectFilter) continue;
      result.push(s);
    }
  }
  return result;
}

// -- Store interface --

interface InboxStoreState {
  sessions: Record<string, InboxSession>;
  pending: Record<string, PendingEntry>;
  currentSessionId: string | null;
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
  updateReviewComment: (conversationId: string, id: string, body: string) => void;
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
  _setDispatchError: (fn: (action: string, error: unknown) => void) => void;
  _dispatch: (action: string, args: any, patches?: any, result?: any) => Promise<any>;
  dispatchErrors: number;

  // -- Wrapped actions (middleware creates aliases from do_* -> *) --
  stashSession: (id: string, opts?: { kill?: boolean }) => void;
  markSessionsDismissed: (ids: string[]) => void;
  applyDismissedReconcile: (entries: { _id: string; inbox_dismissed_at: number | null }[], final: boolean) => void;
  unstashSession: (id: string) => void;
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
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; create: (stubId: string) => Promise<string> }) => { stubId: string; ready: Promise<string> };

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
  setCurrentSession: (id: string) => void;
  clearSelection: () => void;
  setShowDismissed: (show: boolean) => void;
  toggleShowDismissed: () => void;
  toggleCollapsedSection: (key: string) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  preloadForkSessions: (forks: ForkChild[], forkedFrom?: string) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  setConversationAgent: (id: string, agentType: string) => void;
  navigateToSession: (id: string) => void;
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
};

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
          Object.keys(table).length > 0 && draft.clientStateInitialized) {
        const persisted = draft.clientState.current_conversation_id;
        const sorted = sortSessions(table as Record<string, InboxSession>);
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
  clientState: {
    kind: "singleton",
    merge: {
      ui: "local_wins",
      layouts: "local_wins",
      dismissed: "local_wins",
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
        if (incoming.current_conversation_id && !draft.currentSessionId) {
          if (draft.sessions[incoming.current_conversation_id]) {
            draft.currentSessionId = incoming.current_conversation_id;
          } else {
            draft.pendingNavigateId = incoming.current_conversation_id;
          }
        }
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
    draft.currentSessionId = newId;
    draft.clientState.current_conversation_id = newId;
  }
  if (draft.currentConversation?.conversationId === oldId) {
    draft.currentConversation.conversationId = newId;
  }
  if (draft.sidePanelSessionId === oldId) {
    draft.sidePanelSessionId = newId;
  }
}

export const useInboxStore = create<InboxStoreState>(
  mutativeMiddleware((set: any, get: any) => ({
  // -- Initial state --
  sessions: {},
  pending: {},
  dispatchErrors: 0,
  currentSessionId: null,
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
  updateReviewComment: (conversationId: string, id: string, body: string) =>
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
      const next = (s.reviewComments[conversationId] ?? []).filter((c: PendingComment) => c.id !== id);
      const map = { ...s.reviewComments };
      if (next.length) map[conversationId] = next;
      else delete map[conversationId];
      return { reviewComments: map };
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
    this.activeProjectFilter = name;
    this.activeProjectPath = path ?? null;
  }),

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  stashSession: action(function (this: Draft, id: string, opts?: { kill?: boolean }) {
    (opts?.kill ? soundKill : soundDismiss)();
    const now = Date.now();
    const sessionValues = Object.values(this.sessions) as InboxSession[];
    const childIds = sessionValues
      .filter((s) => s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    let newSessionId = this.currentSessionId;
    if (this.currentSessionId && allIds.includes(this.currentSessionId)) {
      const removedSet = new Set(allIds);
      const ordered = visualOrderSessions(this.sessions as Record<string, InboxSession>, this.sessionsWithQueuedMessages, this.activeProjectFilter, sessionsWithPendingSend(this.pendingMessages));
      const idx = ordered.findIndex(s => s._id === this.currentSessionId);
      const next = ordered.slice(idx + 1).find(s => !removedSet.has(s._id))
        ?? ordered.find(s => !removedSet.has(s._id));
      newSessionId = next?._id ?? null;
    }
    for (const sid of allIds) {
      const sess = this.sessions[sid];
      const wasPinned = sess?.is_pinned;
      if (sess) {
        sess.inbox_dismissed_at = now;
        if (wasPinned) {
          sess.is_pinned = false;
          sess.inbox_pinned_at = null;
        }
      }
      if (this.conversations[sid]) {
        (this.conversations[sid] as any).inbox_dismissed_at = now;
        if (wasPinned) (this.conversations[sid] as any).inbox_pinned_at = null;
      }
    }
    this.currentSessionId = newSessionId;
    this.clientState.current_conversation_id = newSessionId ?? undefined;
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

  // Durable cross-device dismiss reconcile (the backstop the live subscription
  // can't provide). `entries` is the server's CURRENT dismissed set within the
  // window (conversations.listDismissedSessionsLite). Overlays it onto the
  // never-prune cache:
  //   SET   — a cached session the server reports dismissed (heals a dismiss made
  //           while this device was offline; the updated_at-keyed session crawl
  //           can never carry it).
  //   CLEAR — (final pass only) a session we have flagged dismissed WITHIN the
  //           window that the server no longer reports = un-dismissed elsewhere.
  // Both passes skip ids with a pending inbox_dismissed_at override so an in-flight
  // local dismiss/unstash on THIS device always wins (local-first). A sync() —
  // applying server truth, never re-dispatched. Per-page calls pass final=false
  // (SET only); the final whole-set call passes true (SET + CLEAR), because CLEAR
  // needs the complete set or a row on a later page would be wrongly un-dismissed.
  applyDismissedReconcile: sync(function (this: Draft, entries: { _id: string; inbox_dismissed_at: number | null }[], final: boolean) {
    const server = new Map<string, number | null>();
    for (const e of entries) server.set(e._id, e.inbox_dismissed_at ?? null);
    const lockedLocal = (id: string) =>
      !!this.pending[`sessions:${id}:inbox_dismissed_at`] ||
      !!this.pending[`conversations:${id}:inbox_dismissed_at`];

    for (const [id, ts] of server) {
      if (!ts || lockedLocal(id)) continue;
      const sess = this.sessions[id];
      if (sess && sess.inbox_dismissed_at !== ts) sess.inbox_dismissed_at = ts;
      const conv = this.conversations[id] as any;
      if (conv && conv.inbox_dismissed_at !== ts) conv.inbox_dismissed_at = ts;
    }

    if (!final) return;

    const cutoff = Date.now() - DISMISS_RECONCILE_WINDOW_MS;
    for (const id of Object.keys(this.sessions)) {
      const sess = this.sessions[id];
      const at = sess.inbox_dismissed_at;
      if (!at || at < cutoff || server.has(id) || lockedLocal(id)) continue;
      sess.inbox_dismissed_at = null;
      const conv = this.conversations[id] as any;
      if (conv) conv.inbox_dismissed_at = null;
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

    this.currentSessionId = sessionId;
    this.viewingDismissedId = null;
    this.clientState.current_conversation_id = sessionId;

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


  unstashSession: action(function (this: Draft, id: string) {
    const childIds = Object.values(this.sessions as Record<string, InboxSession>)
      .filter((s) => isSessionDismissed(s) && s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    for (const sid of allIds) {
      if (this.sessions[sid]) this.sessions[sid].inbox_dismissed_at = null;
      if (this.conversations[sid]) (this.conversations[sid] as any).inbox_dismissed_at = null;
    }
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    this.clientState.current_conversation_id = id;
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
  beginOptimisticSession: (opts: { agentType: string; projectPath?: string; gitRoot?: string; create: (stubId: string) => Promise<string> }) => {
    const store = get();
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
    const ready = opts.create(stubId).then((convexId: string) => {
      if (convexId) store.resolveSessionId(stubId, convexId);
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

  _applyClientDismissed: sync(function (this: Draft, key: string, value: any) {
    if (!this.clientState.dismissed) this.clientState.dismissed = {};
    (this.clientState.dismissed as any)[key] = value;
  }),

  updateClientDismissed: (key: string, value: any) => {
    (get() as any)._applyClientDismissed(key, value);
    const dispatch = () => get()._dispatch("patch", [], { client_state: { _: { dismissed: { [key]: value } } } });
    dispatch().catch(() => setTimeout(() => dispatch().catch(() => {}), 3000));
  },

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
      (config.isDelta || config.ignoreFields || config.preserveFields)
        ? { isDelta: config.isDelta, ignoreFields: config.ignoreFields, preserveFields: config.preserveFields }
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

  visualOrder: () => {
    return visualOrderSessions(get().sessions, get().sessionsWithQueuedMessages, get().activeProjectFilter, sessionsWithPendingSend(get().pendingMessages));
  },

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

  setCurrentSession: action(function (this: Draft, id: string) {
    recordSessionView(this, id, this.currentSessionId);
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    this.clientState.current_conversation_id = id;
  }),

  clearSelection: action(function (this: Draft) {
    this.viewingDismissedId = null;
  }),

  setShowDismissed: action(function (this: Draft, show: boolean) {
    this.clientState.show_dismissed = show;
  }),

  toggleShowDismissed: action(function (this: Draft) {
    this.clientState.show_dismissed = this.clientState.show_dismissed === false;
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
    // Dismiss is absolute — never altered by viewing. If the injected session
    // arrived dismissed, surface it through viewingDismissedId so the user can
    // read it without resurrecting it into the active inbox.
    this.sessions[session._id] = { ...session };
    if (isSessionDismissed(session)) {
      this.viewingDismissedId = session._id;
    } else {
      recordSessionView(this, session._id, this.currentSessionId);
      this.currentSessionId = session._id;
      this.viewingDismissedId = null;
      this.clientState.current_conversation_id = session._id;
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

  navigateToSession: action(function (this: Draft, id: string) {
    // Plain navigation. Forks are first-class conversations — clicking one
    // (in the sidebar, BranchSelector, or a deep link) just sets it as the
    // current conversation. No overlay-on-parent state to keep in sync.
    //
    // Dismiss is absolute: navigation NEVER clears `inbox_dismissed_at`.
    // Deep-link / URL `?s=` / popstate / palette / desktop window-focus all
    // funnel through here, and silently resurrecting a dismissed session was
    // the long-running "dismiss doesn't stick" bug. A dismissed target is
    // shown through `viewingDismissedId` (the same view-only path the inbox
    // sidebar uses when you click a session under "Dismissed"); only an
    // explicit `unstashSession` or sending a message clears dismiss.
    const session = this.sessions[id];
    if (session) {
      if (isSessionDismissed(session)) {
        this.viewingDismissedId = id;
      } else {
        recordSessionView(this, id, this.currentSessionId);
        this.currentSessionId = id;
        this.viewingDismissedId = null;
        this.clientState.current_conversation_id = id;
      }
    } else {
      this.pendingNavigateId = id;
      this.viewingDismissedId = null;
    }
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
      const ordered = visualOrderSessions(this.sessions as Record<string, InboxSession>, this.sessionsWithQueuedMessages, this.activeProjectFilter, sessionsWithPendingSend(this.pendingMessages));
      const idx = ordered.findIndex(s => s._id === id);
      const next = ordered.slice(idx + 1).find(s => s._id !== id)
        ?? ordered.find(s => s._id !== id);
      newSessionId = next?._id ?? null;
    }
    delete this.sessions[id];
    this.currentSessionId = newSessionId;
    this.clientState.current_conversation_id = newSessionId ?? undefined;
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
    const state = get();
    const newOptimistic = state.optimisticForkChildren.map((f: ForkChild) =>
      f._id === sessionId ? { ...f, _id: convexId } : f
    );
    const newMessages = { ...state.messages };
    if (newMessages[sessionId]) {
      newMessages[convexId] = newMessages[sessionId];
      delete newMessages[sessionId];
    }
    set({
      optimisticForkChildren: newOptimistic,
      messages: newMessages,
    });
  },

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
    const newTabs = this.tabs.filter((t: AppTab) => t.id !== id);
    if (this.activeTabId === id) {
      const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
      this.activeTabId = nextTab?.id ?? null;
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
        } else if (key === "collapsedSections" || key === "sidebarNavExpanded" || key === "_lastViewedAt" || key === "_seenUpToAt" || key === "_seenMessageCount") {
          updates[key] = { ...val, ...cur };
        } else if (key === "teamUnreadCount") {
          if (state.teamUnreadCount == null) updates[key] = val;
        } else if (Array.isArray(val)) {
          if (cur?.length === 0) updates[key] = val;
        } else if (typeof val === "object") {
          // Cache as the floor: backfill cached rows the live window omitted,
          // live wins per-id. (Was an empty-gate that skipped IDB entirely once
          // any live row had landed — see unionHydrate.)
          updates[key] = unionHydrate(val, cur);
        } else {
          updates[key] = val;
        }
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

    // Don't load messages from monolithic meta blob — they're now loaded
    // per-conversation from the dedicated IDB table on demand.
    delete cached.messages;
    delete cached.pagination;

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

    // Critical path: sidebar + current conversation + tabs render immediately.
    // feedConversations is here (not deferred) so the team activity feed paints
    // from cache on first frame — no loading screen on open.
    apply(["sessions", "clientState", "_lastViewedAt", "_seenUpToAt", "_seenMessageCount",
           "conversations", "pending", "pendingMessages", "teams", "teamMembers", "teamUnreadCount", "drafts",
           "tabs", "activeTabId", "feedConversations", "feedHasMore", "feedCursors", "syncMeta",
           "sidePanelOpen", "sidePanelSessionId", "sidePanelUserClosed"]);

    // Always mark initialized after IDB hydration completes — even if cached
    // clientState was missing — so app gates don't hang on fresh users.
    if (!useInboxStore.getState().clientStateInitialized) {
      useInboxStore.setState({ clientStateInitialized: true });
    }

    // Restore selected session from persisted clientState before React effects
    // can auto-select the first session (QueuePageClient's fallback effect).
    const st = useInboxStore.getState();
    if (!st.currentSessionId) {
      const persistedId = st.clientState?.current_conversation_id;
      if (persistedId && st.sessions[persistedId]) {
        // The divider anchor (_seenUpToAt) is persisted, so reopening the app to
        // this session naturally shows what arrived while it was closed — no
        // special seeding needed here.
        useInboxStore.setState({ currentSessionId: persistedId });
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
      apply(["tasks", "docs", "plans", "projects", "favorites", "bookmarks",
             "recentProjects", "docProjectPaths", "collapsedSections", "sidebarNavExpanded"]);
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
