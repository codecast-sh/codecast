import { create } from "zustand";
import { useSyncExternalStore, useRef } from "react";
import { mutativeMiddleware, action, asyncAction, sync } from "./mutativeMiddleware";
import { applySyncTable, type PendingEntry } from "./syncProtocol";
import { soundDismiss } from "../lib/sounds";
import { loadCache, writePatchesToIDB, setHydrating, loadConversationMessages, writeConversationMessages } from "./idbCache";

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
  is_unresponsive?: boolean;
  is_connected?: boolean;
  has_pending: boolean;
  agent_status?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming";
  is_deferred?: boolean;
  is_pinned?: boolean;
  last_user_message?: string | null;
  session_error?: string;
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

export type ClientState = {
  current_conversation_id?: string;
  show_dismissed?: boolean;
  dismissed_ids?: string[];

  ui?: ClientUI;
  layouts?: ClientLayouts;
  dismissed?: ClientDismissed;
  tips?: ClientTips;
  drafts?: Record<string, Record<string, any> | null>;

  // deprecated: backward compat
  sidebar_collapsed?: boolean;
  zen_mode?: boolean;
  layout?: { sidebar: number; main: number };
};

type Draft = InboxStoreState;

// -- Helpers --

export function sortSessions(sessions: Record<string, InboxSession>): InboxSession[] {
  const list = Object.values(sessions);
  list.sort((a, b) => {
    const aWaitingForInput = isSessionWaitingForInput(a);
    const bWaitingForInput = isSessionWaitingForInput(b);
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.is_deferred !== b.is_deferred) return a.is_deferred ? 1 : -1;
    if (!isConvexId(a._id) !== !isConvexId(b._id)) return !isConvexId(a._id) ? -1 : 1;
    const aNew = a.message_count === 0;
    const bNew = b.message_count === 0;
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (aWaitingForInput !== bWaitingForInput) return aWaitingForInput ? -1 : 1;
    const aIdle = isSessionEffectivelyIdle(a);
    const bIdle = isSessionEffectivelyIdle(b);
    if (aIdle !== bIdle) return aIdle ? -1 : 1;
    return 0;
  });
  return list;
}

export function isInterruptControlMessage(raw: string | null | undefined): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) return false;
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

const ACTIVE_AGENT_STATUSES: Set<string> = new Set(["working", "compacting", "thinking", "connected", "starting", "resuming"]);
const DEAD_AGENT_STATUSES: Set<string> = new Set(["stopped"]);

export function isSessionEffectivelyIdle(
  session: Pick<InboxSession, "is_idle" | "agent_status">,
): boolean {
  if (session.agent_status) return !ACTIVE_AGENT_STATUSES.has(session.agent_status);
  return session.is_idle;
}

export function isSessionWaitingForInput(
  session: Pick<InboxSession, "_id" | "is_idle" | "agent_status" | "message_count" | "is_pinned">,
  sessionsWithQueuedMessages?: Set<string>,
): boolean {
  // Dead sessions (stopped/crashed) still need user attention if they have messages
  if (session.agent_status && DEAD_AGENT_STATUSES.has(session.agent_status)) {
    return session.message_count > 0 && !session.is_pinned;
  }
  return isSessionEffectivelyIdle(session) &&
    session.message_count > 0 &&
    !session.is_pinned &&
    !sessionsWithQueuedMessages?.has(session._id);
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

export interface CategorizedSessions {
  sorted: InboxSession[];
  pinned: InboxSession[];
  newSessions: InboxSession[];
  needsInput: InboxSession[];
  working: InboxSession[];
  subsByParent: Map<string, InboxSession[]>;
  forksByParent: Map<string, InboxSession[]>;
}

export function categorizeSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
): CategorizedSessions {
  const sorted = sortSessions(sessions);
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
  const forksWithParent = new Set(Array.from(forksByParent.values()).flat().map((s) => s._id));

  const isTop = (s: InboxSession) => !subsWithParent.has(s._id) && !forksWithParent.has(s._id);

  const pinned = sorted.filter((s) => s.is_pinned && isTop(s));
  const newSessions = sorted.filter((s) => s.message_count === 0 && !s.is_pinned && isTop(s))
    .sort((a, b) => (a.is_connected ? 1 : 0) - (b.is_connected ? 1 : 0));
  const needsInput = sorted.filter((s) => isSessionWaitingForInput(s, sessionsWithQueuedMessages) && isTop(s));
  const working = sorted.filter((s) => (!isSessionWaitingForInput(s, sessionsWithQueuedMessages) && s.message_count > 0 && !s.is_pinned) && isTop(s));

  return { sorted, pinned, newSessions, needsInput, working, subsByParent, forksByParent };
}

export function visualOrderSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
  projectFilter?: string | null,
): InboxSession[] {
  const { pinned, newSessions, needsInput, working } =
    categorizeSessions(sessions, sessionsWithQueuedMessages);
  const result: InboxSession[] = [];
  for (const section of [pinned, newSessions, needsInput, working]) {
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
  dismissedSessions: Record<string, InboxSession>;
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
  showAllSessions: boolean;
  toggleShowAllSessions: () => void;
  hiddenSessionCount: number;
  _lastViewedAt: Record<string, number>;

  messages: Record<string, Message[]>;
  pendingMessages: Record<string, Message[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;

  clientState: ClientState;
  clientStateInitialized: boolean;

  drafts: Record<string, Record<string, any>>;

  currentConversation: CurrentConversationContext;
  isolatedWorktreeMode: boolean;
  setIsolatedWorktreeMode: (val: boolean) => void;

  // -- New session modal --
  newSession: { isOpen: boolean; context: SessionContext };
  openNewSession: (ctx?: SessionContext) => void;
  closeNewSession: () => void;

  // -- Compose palette --
  composePalette: { isOpen: boolean; initialMessage: string };
  openComposePalette: (initialMessage?: string) => void;
  closeComposePalette: () => void;

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
  activeBranches: Record<string, string>;
  optimisticForkChildren: ForkChild[];
  activeForkHighlight: string | null;
  pendingForkActivation: string | null;
  setActiveForkHighlight: (id: string | null) => void;
  setPendingForkActivation: (id: string | null) => void;

  // -- Dispatch (provided by middleware) --
  _setDispatch: (fn: (action: string, args: any, patches?: any) => Promise<any>) => void;
  _dispatch: (action: string, args: any, patches?: any) => Promise<any>;

  // -- Wrapped actions (middleware creates aliases from do_* -> *) --
  stashSession: (id: string) => void;
  unstashSession: (id: string) => void;
  deferSession: (id: string) => void;
  pinSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  switchProject: (convId: string, path: string) => void;
  sendMessage: (convId: string, content: string, imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) => Promise<any>;
  resumeSession: (convId: string) => Promise<any>;
  sendEscape: (convId: string) => void;
  createSession: (opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string }) => Promise<any>;
  switchAgent: (currentId: string, targetAgentType: string) => string | null;

  // -- Generic sync --
  syncTable: (field: string, incoming: any, opts?: SyncOpts) => void;
  syncRecord: (field: string, id: string, record: any) => void;
  addPending: (key: string, entry: PendingEntry) => void;
  clearPending: (key: string) => void;
  sortedSessions: () => InboxSession[];
  visualOrder: () => InboxSession[];

  // -- Navigation --
  advanceToNext: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  setCurrentSession: (id: string) => void;
  clearSelection: () => void;
  setShowDismissed: (show: boolean) => void;
  toggleCollapsedSection: (key: string) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  setConversationAgent: (id: string, agentType: string) => void;
  navigateToSession: (id: string) => void;
  touchMru: (id: string) => void;
  markKilling: (id: string) => void;

  // -- Message actions --
  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => void;
  mergeMessages: (convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) => void;
  addOptimisticMessage: (convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => string;
  markOptimisticAsQueued: (convId: string, content: string) => void;
  markOptimisticAsFailed: (convId: string, clientId: string) => void;
  setPagination: (convId: string, update: Partial<PaginationState>) => void;
  initPagination: (convId: string) => void;

  // -- Metadata --
  setCurrentConversation: (ctx: CurrentConversationContext) => void;
  clearCurrentConversation: () => void;

  // -- Drafts --
  setDraft: (id: string, fields: Record<string, any>) => void;
  setDraftLocal: (id: string, fields: Record<string, any>) => void;
  getDraft: (id: string) => Record<string, any> | undefined;
  moveDraft: (fromId: string, toId: string) => void;
  clearDraft: (id: string) => void;
  clearDraftFinal: (id: string) => void;

  // -- Session ID resolution --
  resolveSessionId: (sessionId: string, convexId: string) => void;
  getConvexId: (id: string) => string | undefined;

  // -- Fork navigation --
  switchBranch: (messageUuid: string, convId: string) => void;
  clearBranch: (messageUuid: string) => void;
  addOptimisticFork: (fork: ForkChild) => void;
  pruneOptimisticForks: (serverIds: Set<string>) => void;
  resolveForkSessionId: (sessionId: string, convexId: string) => void;
  resetForkNav: () => void;

  // -- Client prefs (mutative actions -> auto-dispatch) --
  updateClientUI: (partial: Partial<ClientUI>) => void;
  updateClientLayout: (key: keyof ClientLayouts, value: any) => void;
  updateClientDismissed: (key: keyof ClientDismissed, value: any) => void;
  updateClientTips: (partial: Partial<ClientTips>) => void;

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

  // -- Task / Doc / Plan state --
  tasks: Record<string, TaskItem>;
  docs: Record<string, DocItem>;
  plans: Record<string, PlanItem>;
  docProjectPaths: string[];
  docDetails: Record<string, DocDetail>;
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
  openSidePanel: (sessionId: string) => void;
  closeSidePanel: () => void;
  clearSidePanelSession: () => void;
  toggleSidePanel: () => void;
  selectPanelSession: (sessionId: string | null) => void;

  // -- Task / Doc mutations (action + side effect) --
  updateTaskStatus: (shortId: string, status: string) => Promise<any>;
  updateTask: (shortId: string, fields: { status?: string; priority?: string; title?: string; description?: string; labels?: string[]; triage_status?: string }) => Promise<any>;
  createTask: (opts: { title: string; description?: string; task_type?: string; priority?: string; status?: string; project_id?: string; labels?: string[] }) => Promise<any>;
  addTaskComment: (shortId: string, text: string, commentType?: string) => Promise<any>;
  updateDoc: (id: string, fields: { content?: string; title?: string; doc_type?: string; labels?: string[] }) => void;
  pinDoc: (id: string, pinned: boolean) => Promise<any>;
  archiveDoc: (id: string) => Promise<any>;

  // -- Cached query data (local-first) --
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
  }
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
  transform?: (draft: any, result: any, incoming: any, initialized: boolean) => void;
  extra?: Record<string, any>;
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
    transform(draft, table, incoming) {
      for (const s of incoming as any[]) {
        if (!draft.conversations[s._id]) draft.conversations[s._id] = { _id: s._id };
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
  clientState: {
    kind: "singleton",
    merge: {
      ui: "local_wins",
      layouts: "deep_merge",
      dismissed: "deep_merge",
      drafts: "local_wins",
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
  teams: { kind: "list" },
  teamMembers: { kind: "list" },
  teamUnreadCount: { kind: "scalar" },
  favorites: { kind: "list" },
  bookmarks: { kind: "list" },
};

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
  dismissedSessions: {},
  pending: {},
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
  showAllSessions: true,
  toggleShowAllSessions: () => set({ showAllSessions: !get().showAllSessions }),
  hiddenSessionCount: 0,
  _lastViewedAt: {},

  messages: {},
  pendingMessages: {},
  pagination: {},
  conversations: {},
  clientState: {},
  clientStateInitialized: false,

  drafts: {},

  currentConversation: {},
  isolatedWorktreeMode: false,

  newSession: { isOpen: false, context: {} },

  openNewSession: (ctx?: SessionContext) => {
    set({ newSession: { isOpen: true, context: ctx || {} } });
  },

  closeNewSession: () => {
    set({ newSession: { isOpen: false, context: {} } });
  },

  composePalette: { isOpen: false, initialMessage: "" },

  openComposePalette: (initialMessage?: string) => {
    set({ composePalette: { isOpen: true, initialMessage: initialMessage || "" } });
  },

  closeComposePalette: () => {
    set({ composePalette: { isOpen: false, initialMessage: "" } });
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

  activeBranches: {},
  optimisticForkChildren: [],
  activeForkHighlight: null,
  pendingForkActivation: null,
  setActiveForkHighlight: (id: string | null) => set({ activeForkHighlight: id }),
  setPendingForkActivation: (id: string | null) => set({ pendingForkActivation: id }),
  recentProjects: [],
  setRecentProjects: (projects: Array<{ path: string; count: number; lastActive: number }>) => set({ recentProjects: projects }),
  activeProjectPath: null,
  activeProjectFilter: null,
  setActiveProjectFilter: (name: string | null, path?: string | null) => {
    set({ activeProjectFilter: name, activeProjectPath: path ?? null });
  },

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  stashSession: action(function (this: Draft, id: string) {
    soundDismiss();
    const now = Date.now();
    const sessionValues = Object.values(this.sessions) as InboxSession[];
    const childIds = sessionValues
      .filter((s) => s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    let newSessionId = this.currentSessionId;
    if (this.currentSessionId && allIds.includes(this.currentSessionId)) {
      const removedSet = new Set(allIds);
      const ordered = visualOrderSessions(this.sessions as Record<string, InboxSession>, this.sessionsWithQueuedMessages, this.activeProjectFilter);
      const idx = ordered.findIndex(s => s._id === this.currentSessionId);
      const next = ordered.slice(idx + 1).find(s => !removedSet.has(s._id))
        ?? ordered.find(s => !removedSet.has(s._id));
      newSessionId = next?._id ?? null;
    }
    for (const sid of allIds) {
      const wasPinned = this.sessions[sid]?.is_pinned;
      delete this.sessions[sid];
      this.pending[`sessions:${sid}`] = { type: "exclude", expiresAt: now + 15_000 };
      if (this.conversations[sid]) {
        (this.conversations[sid] as any).inbox_dismissed_at = now;
        if (wasPinned) (this.conversations[sid] as any).inbox_pinned_at = null;
      }
    }
    this.currentSessionId = newSessionId;
    this.clientState.current_conversation_id = newSessionId ?? undefined;
  }),

  switchAgent: action(function (this: Draft, currentId: string, targetAgentType: string) {
    const session = this.sessions[currentId];
    if (!session) return null;

    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    const agentLabels: Record<string, string> = { claude_code: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini" };

    delete this.sessions[currentId];
    this.pending[`sessions:${currentId}`] = { type: "exclude", expiresAt: now + 15_000 };
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
    const childIds = Object.values(this.dismissedSessions as Record<string, InboxSession>)
      .filter((s) => s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    for (const sid of allIds) {
      if (this.conversations[sid]) (this.conversations[sid] as any).inbox_dismissed_at = null;
      delete this.pending[`sessions:${sid}`];
      if (this.dismissedSessions[sid]) {
        this.sessions[sid] = this.dismissedSessions[sid];
        delete this.dismissedSessions[sid];
      }
    }
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    this.clientState.current_conversation_id = id;
  }),

  deferSession: action(function (this: Draft, id: string) {
    if (this.sessions[id]) this.sessions[id].is_deferred = true;
    if (this.conversations[id]) (this.conversations[id] as any).inbox_deferred_at = Date.now();
    this.pending[`sessions:${id}:is_deferred`] = { type: "field", value: true, expiresAt: Date.now() + 15_000 };
  }),

  pinSession: action(function (this: Draft, id: string) {
    const newPinned = !this.sessions[id]?.is_pinned;
    const pinnedAt = newPinned ? Date.now() : null;
    if (this.sessions[id]) this.sessions[id].is_pinned = newPinned;
    if (this.conversations[id]) (this.conversations[id] as any).inbox_pinned_at = pinnedAt;
    this.pending[`sessions:${id}:is_pinned`] = { type: "field", value: newPinned, expiresAt: Date.now() + 15_000 };
  }),

  renameSession: action(function (this: Draft, id: string, title: string) {
    if (this.sessions[id]) this.sessions[id].title = title;
    if (this.conversations[id]) this.conversations[id].title = title;
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

  sendMessage: action(function (this: Draft, convId: string, content: string, _imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg = {
      _id: id,
      role: "user" as const,
      content,
      timestamp: Date.now(),
      _isOptimistic: true as const,
      _clientId: id,
      ...(images && images.length > 0 ? { images } : {}),
    };
    if (!this.pendingMessages[convId]) this.pendingMessages[convId] = [];
    this.pendingMessages[convId].push(msg);
  }),

  resumeSession: action(function (_convId: string) {}),

  sendEscape: action(function (_convId: string) {}),

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

  updateClientUI: action(function (this: Draft, partial: Partial<ClientUI>) {
    if (!this.clientState.ui) this.clientState.ui = {} as ClientUI;
    Object.assign(this.clientState.ui, partial);
  }),

  updateClientLayout: action(function (this: Draft, key: string, value: any) {
    if (!this.clientState.layouts) this.clientState.layouts = {};
    (this.clientState.layouts as any)[key] = value;
  }),

  updateClientDismissed: action(function (this: Draft, key: string, value: any) {
    if (!this.clientState.dismissed) this.clientState.dismissed = {};
    (this.clientState.dismissed as any)[key] = value;
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
    const { table, pending } = applySyncTable(field, incoming, this.pending);

    if (config.altKey) {
      const prev = (this as any)[field] || {};
      const incomingByAlt = new Map(
        (incoming as any[]).map((r: any) => [r[config.altKey!], r])
      );
      for (const [oldId, old] of Object.entries(prev)) {
        if (isConvexId(oldId)) continue;
        const match = incomingByAlt.get((old as any)[config.altKey!] || oldId);
        if (match) {
          rekeyId(this, oldId, match._id);
        } else if (!table[oldId]) {
          table[oldId] = old as any;
        }
      }
    }

    if (config.keepSelected) {
      const selectedId = (this as any)[config.keepSelected];
      const prev = (this as any)[field] || {};
      if (selectedId && !table[selectedId] && prev[selectedId]) {
        table[selectedId] = prev[selectedId];
      }
    }

    if (!config.altKey && !config.extra && !config.transform) {
      const prev = (this as any)[field];
      if (prev) {
        const newKeys = Object.keys(table);
        if (newKeys.length === Object.keys(prev).length &&
            newKeys.every(k => prev[k]?.updated_at === (table[k] as any)?.updated_at)) {
          return;
        }
      }
    }

    (this as any)[field] = table;
    this.pending = pending as any;
    if (config.transform) config.transform(this, table, incoming, false);
    if (config.extra) Object.assign(this, config.extra);
  }),

  syncRecord: sync(function (this: Draft, field: string, id: string, record: any) {
    const collection = (this as any)[field];
    const existing = collection?.[id];

    // Bail out if every incoming property already matches — avoids creating
    // a new state reference, which would cascade through useTrackedStore →
    // storeMeta → conversation prop → ConversationView re-render → Radix
    // tooltip ref loop under React 19's ref cleanup semantics.
    if (existing && record) {
      const keys = Object.keys(record);
      if (keys.length > 0 && keys.every(k => Object.is(existing[k], record[k]))) {
        return;
      }
    }

    // Mutate draft in-place instead of replacing the collection object.
    // This ensures mutative only marks the changed subtree as dirty.
    if (!collection) {
      (this as any)[field] = { [id]: record };
    } else if (!existing) {
      collection[id] = record;
    } else {
      for (const key of Object.keys(record)) {
        if (!Object.is(existing[key], record[key])) {
          existing[key] = record[key];
        }
      }
    }
  }),

  addPending: sync(function (this: Draft, key: string, entry: PendingEntry) {
    this.pending[key] = entry;
  }),

  clearPending: sync(function (this: Draft, key: string) {
    delete this.pending[key];
  }),

  sortedSessions: () => {
    return sortSessions(get().sessions).filter((s: InboxSession) => !s.is_subagent && !s.parent_conversation_id);
  },

  visualOrder: () => {
    return visualOrderSessions(get().sessions, get().sessionsWithQueuedMessages, get().activeProjectFilter);
  },

  // =====================
  // NAVIGATION
  // =====================

  advanceToNext: () => {
    const sorted = get().sortedSessions();
    const currentId = get().currentSessionId;
    const filter = get().activeProjectFilter;
    const idleSessions = sorted.filter((s: InboxSession) =>
      isSessionWaitingForInput(s) &&
      (!filter || getProjectName(s.git_root, s.project_path) === filter)
    );
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
    get().setCurrentSession(ordered[newIdx]._id);
  },

  navigateDown: () => {
    const ordered = get().visualOrder();
    if (ordered.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = ordered.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = (idx + 1) % ordered.length;
    get().setCurrentSession(ordered[newIdx]._id);
  },

  setCurrentSession: action(function (this: Draft, id: string) {
    this.currentSessionId = id;
    this.viewingDismissedId = null;
    this.activeBranches = {};
    // Preserve pendingForkActivation — it's consumed by ConversationView after parent loads.
    // Only clear activeForkHighlight if there's no pending fork.
    if (!this.pendingForkActivation) {
      this.activeForkHighlight = null;
    }
    this.clientState.current_conversation_id = id;
  }),

  clearSelection: action(function (this: Draft) {
    this.viewingDismissedId = null;
  }),

  setShowDismissed: (show: boolean) => {
    set({ showDismissed: show });
  },

  toggleCollapsedSection: (key: string) => {
    const current = get().collapsedSections;
    set({ collapsedSections: { ...current, [key]: !current[key] } });
  },

  setViewingDismissedId: (id: string | null) => {
    set({ viewingDismissedId: id });
  },

  getCurrentSession: () => {
    const { sessions, currentSessionId } = get();
    if (!currentSessionId) return null;
    return sessions[currentSessionId] ?? null;
  },

  injectSession: action(function (this: Draft, session: InboxSession) {
    const excludeKey = `sessions:${session._id}`;
    if (this.pending[excludeKey]) delete this.pending[excludeKey];
    this.sessions[session._id] = session;
    this.currentSessionId = session._id;
    this.viewingDismissedId = null;
    this.clientState.current_conversation_id = session._id;
    if (this.conversations[session._id]) {
      (this.conversations[session._id] as any).inbox_dismissed_at = null;
    }
  }),

  updateSessionProject: sync(function (this: Draft, id: string, projectPath: string) {
    if (!this.sessions[id]) return;
    this.sessions[id].project_path = projectPath;
    this.sessions[id].git_root = projectPath;
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
    const excludeKey = `sessions:${id}`;
    if (this.pending[excludeKey]) {
      delete this.pending[excludeKey];
      if (this.conversations[id]) {
        (this.conversations[id] as any).inbox_dismissed_at = null;
      }
    }
    if (this.sessions[id]) {
      this.currentSessionId = id;
      this.viewingDismissedId = null;
      this.activeBranches = {};
      this.clientState.current_conversation_id = id;
    } else {
      this.pendingNavigateId = id;
      this.viewingDismissedId = null;
    }
  }),

  touchMru: (id: string) => {
    set({ _lastViewedAt: { ...get()._lastViewedAt, [id]: Date.now() } });
  },

  markKilling: action(function (this: Draft, id: string) {
    let newSessionId = this.currentSessionId;
    if (this.currentSessionId === id) {
      const ordered = visualOrderSessions(this.sessions as Record<string, InboxSession>, this.sessionsWithQueuedMessages, this.activeProjectFilter);
      const idx = ordered.findIndex(s => s._id === id);
      const next = ordered.slice(idx + 1).find(s => s._id !== id)
        ?? ordered.find(s => s._id !== id);
      newSessionId = next?._id ?? null;
    }
    delete this.sessions[id];
    this.pending[`sessions:${id}`] = { type: "exclude", expiresAt: Date.now() + 10_000 };
    this.currentSessionId = newSessionId;
    this.clientState.current_conversation_id = newSessionId ?? undefined;
  }),


  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: sync(function (this: Draft, convId: string, msgs: Message[], meta?: Partial<PaginationState>) {
    // Prune confirmed messages from pendingMessages
    const pending = this.pendingMessages[convId] || [];
    if (pending.length > 0) {
      const serverUserMsgs = msgs.filter((m: Message) => m.role === "user");
      this.pendingMessages[convId] = pending.filter((m: Message) => {
        if (m._clientId) {
          return !serverUserMsgs.some((s: Message) => s.client_id === m._clientId);
        }
        const stripped = stripImageRef(m.content || "");
        return !serverUserMsgs.some((s: Message) =>
          stripImageRef(s.content || "") === stripped &&
          Math.abs(s.timestamp - m.timestamp) < 120_000
        );
      });
    }
    // Server data only — pending messages are merged at read time
    this.messages[convId] = msgs;
    const pag = { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...meta };
    this.pagination[convId] = pag;
    writeConversationMessages(convId, msgs, pag);
    evictInactiveMessages(this, convId);
  }),

  mergeMessages: sync(function (this: Draft, convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) {
    const existing = this.messages[convId] || [];
    const existingIds = new Set(existing.map((m: Message) => m._id));
    const unique = msgs.filter((m: Message) => !existingIds.has(m._id));
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

  addOptimisticMessage: sync(function (this: Draft, convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg: Message = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      _clientId: id,
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

  setPagination: (convId: string, update: Partial<PaginationState>) => {
    const state = get();
    set({
      pagination: {
        ...state.pagination,
        [convId]: { ...(state.pagination[convId] || DEFAULT_PAGINATION), ...update },
      },
    });
  },

  initPagination: (convId: string) => {
    const existing = get().pagination[convId];
    if (existing) return;
    set({
      pagination: { ...get().pagination, [convId]: { ...DEFAULT_PAGINATION } },
    });
  },

  // =====================
  // METADATA
  // =====================

  setCurrentConversation: (ctx: CurrentConversationContext) => {
    set({ currentConversation: ctx });
  },

  setIsolatedWorktreeMode: (val: boolean) => {
    set({ isolatedWorktreeMode: val });
  },

  clearCurrentConversation: () => {
    set({ currentConversation: {} });
  },

  // =====================
  // DRAFTS
  // =====================

  setDraft: sync(function (this: Draft, id: string, fields: Record<string, any>) {
    this.drafts[id] = fields;
    if (!this.clientState.drafts) this.clientState.drafts = {};
    this.clientState.drafts[id] = fields;
  }),

  setDraftLocal: (id: string, fields: Record<string, any>) => {
    set((s: InboxStoreState) => ({ drafts: { ...s.drafts, [id]: fields } }));
  },

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

  resolveSessionId: sync(function (this: Draft, sessionId: string, convexId: string) {
    rekeyId(this, sessionId, convexId);
  }),

  getConvexId: (id: string) => {
    if (isConvexId(id)) return id;
    const sessions = get().sessions as Record<string, InboxSession>;
    const session = Object.values(sessions).find((s) => s.session_id === id || s._id === id);
    return session && isConvexId(session._id) ? session._id : undefined;
  },

  // =====================
  // FORK NAVIGATION
  // =====================

  switchBranch: (messageUuid: string, convId: string) => {
    set((s: InboxStoreState) => ({
      activeBranches: { ...s.activeBranches, [messageUuid]: convId },
    }));
  },

  clearBranch: (messageUuid: string) => {
    set((s: InboxStoreState) => {
      const next = { ...s.activeBranches };
      delete next[messageUuid];
      return { activeBranches: next };
    });
  },

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
    const newActiveBranches = { ...state.activeBranches };
    for (const [uuid, cid] of Object.entries(newActiveBranches)) {
      if (cid === sessionId) newActiveBranches[uuid] = convexId;
    }
    const newOptimistic = state.optimisticForkChildren.map((f: ForkChild) =>
      f._id === sessionId ? { ...f, _id: convexId } : f
    );
    const newMessages = { ...state.messages };
    if (newMessages[sessionId]) {
      newMessages[convexId] = newMessages[sessionId];
      delete newMessages[sessionId];
    }
    set({
      activeBranches: newActiveBranches,
      optimisticForkChildren: newOptimistic,
      messages: newMessages,
    });
  },

  resetForkNav: () => {
    set({
      activeBranches: {},
      optimisticForkChildren: [],
      activeForkHighlight: null,
    });
  },

  // =====================
  // TASK / DOC STATE
  // =====================

  sidebarNavExpanded: {},
  toggleSidebarNav: (section: string) => set((s: any) => ({
    sidebarNavExpanded: { ...s.sidebarNavExpanded, [section]: !s.sidebarNavExpanded[section] },
  })),

  tasks: {},
  docs: {},
  plans: {},
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
      this.pending[`tasks:${task._id}:status`] = {
        type: "field", field: "status", value: status, expiresAt: Date.now() + 15_000,
      };
    }
  }),

  updateTask: action(function (this: Draft, shortId: string, fields: Record<string, any>) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as TaskItem | undefined;
    if (task) {
      Object.assign(task, fields, { updated_at: Date.now() });
    }
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

  addTaskComment: action(function (this: Draft, shortId: string, text: string, commentType?: string) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as any;
    if (task?.comments) {
      task.comments.push({
        _id: `temp_${Date.now()}`,
        author: "You",
        text,
        comment_type: commentType || "note",
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

  openSidePanel: (sessionId: string) => {
    set({ sidePanelSessionId: sessionId, sidePanelOpen: true });
  },

  closeSidePanel: () => {
    set({ sidePanelSessionId: null, sidePanelOpen: false });
  },

  clearSidePanelSession: () => {
    set({ sidePanelSessionId: null });
  },

  toggleSidePanel: () => {
    const { sidePanelOpen, sidePanelSessionId, currentSessionId } = get();
    if (sidePanelOpen) {
      set({ sidePanelOpen: false });
    } else {
      set({
        sidePanelOpen: true,
        sidePanelSessionId: sidePanelSessionId || currentSessionId,
      });
    }
  },

  selectPanelSession: (sessionId: string | null) => {
    set({ sidePanelSessionId: sessionId });
  },

  // =====================
  // CACHED QUERY DATA
  // =====================

  teams: [],
  teamMembers: [],
  teamUnreadCount: null,
  favorites: [],
  bookmarks: [],

  // =====================
  // SELECTORS
  // =====================

  getSession: (id: string) => {
    const { sessions, dismissedSessions } = get();
    return sessions[id] || dismissedSessions[id];
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

// -- IndexedDB cache: wire patch-driven writes + hydrate on load --

if (typeof window !== "undefined") {
  (useInboxStore.getState() as any)._setIDBWrite(writePatchesToIDB);

  setHydrating(true);
  loadCache().then((cached) => {
    setHydrating(false);
    if (!cached) return;

    const apply = (pick: string[]) => {
      const state = useInboxStore.getState();
      const updates: Record<string, any> = {};
      for (const key of pick) {
        const val = cached[key];
        if (val == null) continue;
        const cur = (state as any)[key];
        if (key === "clientState" && state.clientStateInitialized) {
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
          continue;
        }
        if (key === "collapsedSections" || key === "sidebarNavExpanded") {
          updates[key] = { ...val, ...cur };
        } else if (key === "teamUnreadCount") {
          if (state.teamUnreadCount == null) updates[key] = val;
        } else if (Array.isArray(val)) {
          if (cur?.length === 0) updates[key] = val;
        } else if (typeof val === "object") {
          if (Object.keys(cur || {}).length === 0) updates[key] = val;
        }
      }
      if (Object.keys(updates).length > 0) useInboxStore.setState(updates);
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

    // Critical path: sidebar + current conversation render immediately
    apply(["sessions", "dismissedSessions", "clientState",
           "conversations", "teams", "teamMembers", "teamUnreadCount", "drafts"]);

    // Preload messages for all active inbox sessions so clicks are instant
    for (const id of Object.keys(cached.sessions || {})) {
      ensureHydrated(id);
    }

    // Deferred: list views + secondary data render next frame
    requestAnimationFrame(() => {
      apply(["tasks", "docs", "plans", "favorites", "bookmarks",
             "recentProjects", "collapsedSections", "sidebarNavExpanded"]);
    });
  });
}
