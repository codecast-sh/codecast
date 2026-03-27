import { create } from "zustand";
import { mutativeMiddleware, action, sync } from "./mutativeMiddleware";
import { applySyncTable, type PendingEntry } from "./syncProtocol";
import { soundDismiss } from "../lib/sounds";
import { loadCache, writePatchesToIDB, setHydrating } from "./idbCache";

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
  agent_status?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "starting" | "resuming";
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
};

export type ClientState = {
  current_conversation_id?: string;
  show_dismissed?: boolean;
  dismissed_ids?: string[];

  ui?: ClientUI;
  layouts?: ClientLayouts;
  dismissed?: ClientDismissed;
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

export function isSessionInterrupted(session: Pick<InboxSession, "last_user_message">): boolean {
  return isInterruptControlMessage(session.last_user_message);
}

const ACTIVE_AGENT_STATUSES: Set<string> = new Set(["working", "compacting", "thinking", "connected", "starting", "resuming"]);

export function isSessionEffectivelyIdle(
  session: Pick<InboxSession, "is_idle" | "agent_status">,
): boolean {
  if (session.agent_status) return !ACTIVE_AGENT_STATUSES.has(session.agent_status);
  return session.is_idle;
}

export function isSessionWaitingForInput(
  session: Pick<InboxSession, "_id" | "is_idle" | "agent_status" | "message_count" | "is_pinned" | "last_user_message">,
  sessionsWithQueuedMessages?: Set<string>,
): boolean {
  return isSessionEffectivelyIdle(session) &&
    session.message_count > 0 &&
    !session.is_pinned &&
    !sessionsWithQueuedMessages?.has(session._id) &&
    !isSessionInterrupted(session);
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

export interface CategorizedSessions {
  sorted: InboxSession[];
  pinned: InboxSession[];
  newSessions: InboxSession[];
  needsInput: InboxSession[];
  working: InboxSession[];
  subsByParent: Map<string, InboxSession[]>;
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
  const subsWithParent = new Set(Array.from(subsByParent.values()).flat().map((s) => s._id));

  const isTop = (s: InboxSession) => !subsWithParent.has(s._id);

  const pinned = sorted.filter((s) => s.is_pinned && isTop(s));
  const newSessions = sorted.filter((s) => s.message_count === 0 && !s.is_pinned && isTop(s))
    .sort((a, b) => (a.is_connected ? 1 : 0) - (b.is_connected ? 1 : 0));
  const needsInput = sorted.filter((s) => isSessionWaitingForInput(s, sessionsWithQueuedMessages) && isTop(s));
  const working = sorted.filter((s) => (!isSessionWaitingForInput(s, sessionsWithQueuedMessages) && s.message_count > 0 && !s.is_pinned) && isTop(s));

  return { sorted, pinned, newSessions, needsInput, working, subsByParent };
}

export function visualOrderSessions(
  sessions: Record<string, InboxSession>,
  sessionsWithQueuedMessages: Set<string>,
): InboxSession[] {
  const { pinned, newSessions, needsInput, working, subsByParent } =
    categorizeSessions(sessions, sessionsWithQueuedMessages);
  const result: InboxSession[] = [];
  for (const section of [pinned, newSessions, needsInput, working]) {
    for (const s of section) {
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
  showMySessions: boolean;
  setShowMySessions: (show: boolean) => void;
  showAllSessions: boolean;
  toggleShowAllSessions: () => void;
  hiddenSessionCount: number;
  mruStack: string[];

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
  palette: { open: boolean; targets: any[]; targetType: 'task' | 'doc' | 'plan' | null; initialMode: string; initialQuery?: string };
  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan'; mode?: string; initialQuery?: string }) => void;
  closePalette: () => void;
  togglePalette: () => void;

  // -- Create modal --
  createModal: 'task' | 'plan' | 'doc' | null;
  openCreateModal: (type: 'task' | 'plan' | 'doc') => void;
  closeCreateModal: () => void;

  // -- Fork navigation --
  activeBranches: Record<string, string>;
  optimisticForkChildren: ForkChild[];

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
  syncTable: (tableName: string, incoming: Array<{ _id: string; [k: string]: any }>, extra?: Record<string, any>) => void;
  syncRecord: (tableName: string, id: string, record: any) => void;
  syncClientState: (state: any) => void;
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
  setConversationMeta: (convId: string, meta: ConversationMeta) => void;
  updateConversationMeta: (convId: string, partial: Record<string, any>) => void;
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

  // -- Recent projects cache --
  recentProjects: Array<{ path: string; count: number; lastActive: number }>;
  setRecentProjects: (projects: Array<{ path: string; count: number; lastActive: number }>) => void;

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

  // -- Doc detail sync --
  syncDocDetail: (id: string, detail: DocDetail) => void;
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
  syncTeams: (teams: any[]) => void;
  syncTeamMembers: (members: any[]) => void;
  syncTeamUnreadCount: (count: number | null) => void;
  syncFavorites: (favorites: any[]) => void;
  syncBookmarks: (bookmarks: any[]) => void;

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
  showMySessions: false,
  setShowMySessions: (show: boolean) => set({ showMySessions: show }),
  showAllSessions: false,
  toggleShowAllSessions: () => set({ showAllSessions: !get().showAllSessions }),
  hiddenSessionCount: 0,
  mruStack: [],

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

  openPalette: (opts?: { targets?: any[]; targetType?: 'task' | 'doc' | 'plan'; mode?: string; initialQuery?: string }) => {
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
  recentProjects: [],
  setRecentProjects: (projects: Array<{ path: string; count: number; lastActive: number }>) => set({ recentProjects: projects }),

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  stashSession: (id: string) => {
    soundDismiss();
    const state = get();
    const now = Date.now();
    const sessionValues = Object.values(state.sessions) as InboxSession[];
    const childIds = sessionValues
      .filter((s) => s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    const newSessions = { ...state.sessions };
    const newPending = { ...state.pending };
    const newConversations = { ...state.conversations };
    const dispatchConvos: Record<string, any> = {};
    for (const sid of allIds) {
      delete newSessions[sid];
      newPending[`sessions:${sid}`] = { type: "exclude", expiresAt: now + 15_000 };
      const wasPinned = state.sessions[sid]?.is_pinned;
      if (newConversations[sid]) {
        newConversations[sid] = { ...newConversations[sid], inbox_dismissed_at: now, ...(wasPinned ? { inbox_pinned_at: null } : {}) };
      }
      dispatchConvos[sid] = { inbox_dismissed_at: now, ...(state.sessions[sid]?.is_pinned ? { inbox_pinned_at: null } : {}) };
    }
    let newSessionId = state.currentSessionId;
    if (state.currentSessionId && allIds.includes(state.currentSessionId)) {
      const removedSet = new Set(allIds);
      const ordered = visualOrderSessions(state.sessions, state.sessionsWithQueuedMessages);
      const idx = ordered.findIndex(s => s._id === state.currentSessionId);
      const next = ordered.slice(idx + 1).find(s => !removedSet.has(s._id))
        ?? ordered.find(s => !removedSet.has(s._id));
      newSessionId = next?._id ?? null;
    }
    set({
      sessions: newSessions,
      pending: newPending,
      conversations: newConversations,
      currentSessionId: newSessionId,
      clientState: { ...state.clientState, current_conversation_id: newSessionId ?? undefined },
    });
    get()._dispatch("patch", [], {
      conversations: dispatchConvos,
      client_state: { _: { current_conversation_id: newSessionId ?? null } },
    }).catch(() => {});
  },

  switchAgent: (currentId: string, targetAgentType: string) => {
    const state = get();
    const session = state.sessions[currentId];
    if (!session) return null;

    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now();
    const agentLabels: Record<string, string> = { claude_code: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini" };

    const newSessions = { ...state.sessions };
    const newPending = { ...state.pending };
    const newConversations = { ...state.conversations };

    delete newSessions[currentId];
    newPending[`sessions:${currentId}`] = { type: "exclude", expiresAt: now + 15_000 };
    if (newConversations[currentId]) {
      newConversations[currentId] = { ...newConversations[currentId], inbox_dismissed_at: now };
    }

    newSessions[sessionId] = {
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

    set({
      sessions: newSessions,
      pending: newPending,
      conversations: newConversations,
      currentSessionId: sessionId,
      viewingDismissedId: null,
      clientState: { ...state.clientState, current_conversation_id: sessionId },
    });
    get().moveDraft(currentId, sessionId);

    get()._dispatch("patch", [], {
      conversations: { [currentId]: { inbox_dismissed_at: now } },
      client_state: { _: { current_conversation_id: sessionId } },
    }).catch(() => {});

    return sessionId;
  },

  unstashSession: (id: string) => {
    const state = get();
    const childIds = Object.values(state.dismissedSessions as Record<string, InboxSession>)
      .filter((s) => s.parent_conversation_id === id)
      .map((s) => s._id);
    const allIds = [id, ...childIds];
    const newSessions = { ...state.sessions };
    const newDismissedSessions = { ...state.dismissedSessions };
    const newConversations = { ...state.conversations };
    const newPending = { ...state.pending };
    const dispatchConvos: Record<string, any> = {};
    for (const sid of allIds) {
      if (newConversations[sid]) {
        newConversations[sid] = { ...newConversations[sid], inbox_dismissed_at: null };
      }
      delete newPending[`sessions:${sid}`];
      if (newDismissedSessions[sid]) {
        newSessions[sid] = newDismissedSessions[sid];
        delete newDismissedSessions[sid];
      }
      dispatchConvos[sid] = { inbox_dismissed_at: null };
    }
    set({
      sessions: newSessions,
      dismissedSessions: newDismissedSessions,
      conversations: newConversations,
      pending: newPending,
      currentSessionId: id,
      viewingDismissedId: null,
      clientState: { ...state.clientState, current_conversation_id: id },
    });
    get()._dispatch("patch", [], {
      conversations: dispatchConvos,
      client_state: { _: { current_conversation_id: id } },
    }).catch(() => {});
  },

  deferSession: (id: string) => {
    const state = get();
    const newSessions = { ...state.sessions };
    if (newSessions[id]) {
      newSessions[id] = { ...newSessions[id], is_deferred: true };
    }
    const newConversations = { ...state.conversations };
    if (newConversations[id]) {
      newConversations[id] = { ...newConversations[id], inbox_deferred_at: Date.now() };
    }
    const newPending = { ...state.pending };
    newPending[`sessions:${id}:is_deferred`] = { type: "field", value: true, expiresAt: Date.now() + 15_000 };
    set({ sessions: newSessions, conversations: newConversations, pending: newPending });
    get()._dispatch("patch", [], {
      conversations: { [id]: { inbox_deferred_at: Date.now() } },
    }).catch(() => {});
  },

  pinSession: (id: string) => {
    const state = get();
    const isPinned = state.sessions[id]?.is_pinned;
    const newPinned = !isPinned;
    const pinnedAt = newPinned ? Date.now() : null;
    const newSessions = { ...state.sessions };
    if (newSessions[id]) {
      newSessions[id] = { ...newSessions[id], is_pinned: newPinned };
    }
    const newConversations = { ...state.conversations };
    if (newConversations[id]) {
      newConversations[id] = { ...newConversations[id], inbox_pinned_at: pinnedAt };
    }
    const newPending = { ...state.pending };
    newPending[`sessions:${id}:is_pinned`] = { type: "field", value: newPinned, expiresAt: Date.now() + 15_000 };
    set({ sessions: newSessions, conversations: newConversations, pending: newPending });
    get()._dispatch("patch", [], {
      conversations: { [id]: { inbox_pinned_at: pinnedAt } },
    }).catch(() => {});
  },

  renameSession: (id: string, title: string) => {
    const state = get();
    const newSessions = { ...state.sessions };
    if (newSessions[id]) {
      newSessions[id] = { ...newSessions[id], title };
    }
    const newConversations = { ...state.conversations };
    if (newConversations[id]) {
      newConversations[id] = { ...newConversations[id], title };
    }
    set({ sessions: newSessions, conversations: newConversations });
    get()._dispatch("patch", [], {
      conversations: { [id]: { title } },
    }).catch(() => {});
  },

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

  createSession: action(function (this: Draft, opts: { agent_type: string; project_path?: string; git_root?: string; session_id?: string }) {
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
    if (!this.clientState.ui) this.clientState.ui = {};
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

  // =====================
  // GENERIC SYNC
  // =====================

  syncTable: sync(function (this: Draft, tableName: string, incoming: Array<{ _id: string; [k: string]: any }>, extra?: Record<string, any>) {
    const { table, pending } = applySyncTable(tableName, incoming as any, this.pending);

    if (tableName === "sessions") {
      const prev = this.sessions;
      const incomingBySessionId = new Map(incoming.map((s: any) => [s.session_id, s]));
      for (const [oldId, oldSession] of Object.entries(prev)) {
        if (isConvexId(oldId)) continue;
        const match = incomingBySessionId.get((oldSession as InboxSession).session_id || oldId);
        if (match) {
          rekeyId(this, oldId, match._id);
          if (this.currentSessionId === oldId) {
            this.currentSessionId = match._id;
          }
        } else if (!table[oldId]) {
          table[oldId] = oldSession as any;
        }
      }
      if (this.currentSessionId && !table[this.currentSessionId] && prev[this.currentSessionId]) {
        table[this.currentSessionId] = prev[this.currentSessionId] as any;
      }
      for (const s of incoming) {
        if (!this.conversations[s._id]) {
          this.conversations[s._id] = { _id: s._id };
        }
      }
      if (!this.currentSessionId && !this.showMySessions && Object.keys(table).length > 0 && this.clientStateInitialized) {
        const persisted = this.clientState.current_conversation_id;
        const sorted = sortSessions(table as Record<string, InboxSession>);
        this.currentSessionId = (persisted && table[persisted]) ? persisted : (sorted[0]?._id ?? null);
      }
      this.sessions = table as any;
      this.pending = pending as any;
      return;
    }

    const prev = (this as any)[tableName] as Record<string, any> | undefined;
    if (prev && !extra) {
      const newKeys = Object.keys(table);
      if (newKeys.length === Object.keys(prev).length &&
          newKeys.every(k => prev[k]?.updated_at === (table[k] as any)?.updated_at)) {
        return;
      }
    }

    (this as any)[tableName] = table;
    this.pending = pending as any;
    if (extra) Object.assign(this, extra);
  }),

  syncRecord: sync(function (this: Draft, tableName: string, id: string, record: any) {
    const existing = (this as any)[tableName]?.[id];
    (this as any)[tableName] = {
      ...(this as any)[tableName],
      [id]: { ...existing, ...record },
    };
  }),

  syncClientState: sync(function (this: Draft, serverState: any) {
    if (!serverState) return;
    const prev = this.clientState;
    const serverUi = serverState.ui ?? {
      sidebar_collapsed: serverState.sidebar_collapsed,
      zen_mode: serverState.zen_mode,
    };
    const initialized = this.clientStateInitialized;
    this.clientState = {
      current_conversation_id: serverState.current_conversation_id,
      show_dismissed: serverState.show_dismissed,
      dismissed_ids: serverState.dismissed_ids,
      ui: initialized
        ? { ...serverUi, ...prev.ui }
        : serverUi,
      layouts: serverState.layouts ?? (serverState.layout ? {
        dashboard: serverState.layout,
      } : undefined),
      dismissed: { ...prev.dismissed, ...serverState.dismissed },
      drafts: initialized ? prev.drafts : serverState.drafts,
    };
    this.clientStateInitialized = true;
    if (!initialized && serverState.drafts) {
      for (const [k, v] of Object.entries(serverState.drafts)) {
        if (v && typeof v === "object" && !this.drafts[k]) {
          this.drafts[k] = v as Record<string, any>;
        }
      }
    }
    if (!initialized && serverState.current_conversation_id && !this.currentSessionId) {
      if (this.sessions[serverState.current_conversation_id]) {
        this.currentSessionId = serverState.current_conversation_id;
      } else {
        this.pendingNavigateId = serverState.current_conversation_id;
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
    return visualOrderSessions(get().sessions, get().sessionsWithQueuedMessages);
  },

  // =====================
  // NAVIGATION
  // =====================

  advanceToNext: () => {
    const sorted = get().sortedSessions();
    const currentId = get().currentSessionId;
    const idleSessions = sorted.filter((s: InboxSession) => isSessionWaitingForInput(s));
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

  setCurrentSession: (id: string) => {
    const state = get();
    set({
      currentSessionId: id,
      viewingDismissedId: null,
      clientState: { ...state.clientState, current_conversation_id: id },
    });
    get()._dispatch("patch", [], {
      client_state: { _: { current_conversation_id: id } },
    }).catch(() => {});
  },

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

  injectSession: (session: InboxSession) => {
    const state = get();
    const newPending = { ...state.pending };
    const excludeKey = `sessions:${session._id}`;
    if (newPending[excludeKey]) {
      delete newPending[excludeKey];
      get()._dispatch("patch", [], { conversations: { [session._id]: { inbox_dismissed_at: null } } }).catch(() => {});
    }
    set({
      sessions: { ...state.sessions, [session._id]: session },
      currentSessionId: session._id,
      pending: newPending,
      viewingDismissedId: null,
      clientState: { ...state.clientState, current_conversation_id: session._id },
    });
  },

  updateSessionProject: (id: string, projectPath: string) => {
    const { sessions } = get();
    if (!sessions[id]) return;
    set({ sessions: { ...sessions, [id]: { ...sessions[id], project_path: projectPath, git_root: projectPath } } });
  },

  patchSession: (id: string, fields: Partial<InboxSession>) => {
    const { sessions } = get();
    if (!sessions[id]) return;
    set({ sessions: { ...sessions, [id]: { ...sessions[id], ...fields } } });
  },

  setConversationAgent: (id: string, agentType: string) => {
    const state = get();
    const updates: Partial<InboxStoreState> = {};

    if (state.sessions[id]) {
      updates.sessions = {
        ...state.sessions,
        [id]: { ...state.sessions[id], agent_type: agentType },
      };
    }

    if (state.conversations[id]) {
      updates.conversations = {
        ...state.conversations,
        [id]: { ...state.conversations[id], agent_type: agentType },
      };
    }

    if (state.currentConversation.conversationId === id) {
      updates.currentConversation = {
        ...state.currentConversation,
        agentType,
      };
    }

    if (Object.keys(updates).length > 0) {
      set(updates);
    }
  },

  navigateToSession: (id: string) => {
    const state = get();
    const newPending = { ...state.pending };
    const excludeKey = `sessions:${id}`;
    if (newPending[excludeKey]) {
      delete newPending[excludeKey];
      get()._dispatch("patch", [], { conversations: { [id]: { inbox_dismissed_at: null } } }).catch(() => {});
      set({ pending: newPending });
    }
    if (state.sessions[id]) {
      get().setCurrentSession(id);
    } else {
      set({ pendingNavigateId: id, viewingDismissedId: null });
    }
  },

  touchMru: (id: string) => {
    const { mruStack } = get();
    const filtered = mruStack.filter((s: string) => s !== id);
    set({ mruStack: [id, ...filtered] });
  },

  markKilling: (id: string) => {
    const state = get();
    const newSessions = { ...state.sessions };
    delete newSessions[id];
    const newPending = { ...state.pending };
    newPending[`sessions:${id}`] = { type: "exclude", expiresAt: Date.now() + 10_000 };
    let newSessionId = state.currentSessionId;
    if (state.currentSessionId === id) {
      const ordered = visualOrderSessions(state.sessions, state.sessionsWithQueuedMessages);
      const idx = ordered.findIndex(s => s._id === id);
      const next = ordered.slice(idx + 1).find(s => s._id !== id)
        ?? ordered.find(s => s._id !== id);
      newSessionId = next?._id ?? null;
    }
    set({
      sessions: newSessions,
      pending: newPending,
      currentSessionId: newSessionId,
      clientState: { ...state.clientState, current_conversation_id: newSessionId ?? undefined },
    });
    if (state.currentSessionId === id) {
      get()._dispatch("patch", [], {
        client_state: { _: { current_conversation_id: newSessionId ?? null } },
      }).catch(() => {});
    }
  },


  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: sync(function (this: Draft, convId: string, msgs: Message[], meta?: Partial<PaginationState>) {
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
    this.messages[convId] = msgs;
    this.pagination[convId] = { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...meta };
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
    this.messages[convId] = merged;
    if (meta) this.pagination[convId] = { ...(this.pagination[convId] || DEFAULT_PAGINATION), ...meta };
  }),

  addOptimisticMessage: (convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => {
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
    const state = get();
    set({
      pendingMessages: { ...state.pendingMessages, [convId]: [...(state.pendingMessages[convId] || []), msg] },
    });
    return id;
  },

  markOptimisticAsQueued: (convId: string, content: string) => {
    const state = get();
    const stripped = stripImageRef(content);
    const promote = (m: Message) => {
      if (m._isOptimistic && m.role === "user" && stripImageRef(m.content || "") === stripped) {
        const { _isOptimistic, ...rest } = m;
        return { ...rest, _isQueued: true as const };
      }
      return m;
    };
    const pending = state.pendingMessages[convId];
    if (pending) {
      set({ pendingMessages: { ...state.pendingMessages, [convId]: pending.map(promote) } });
    }
  },

  markOptimisticAsFailed: (convId: string, clientId: string) => {
    const state = get();
    const mark = (m: Message): Message => {
      if (m._clientId === clientId || m._id === clientId) {
        return { ...m, _isFailed: true as const };
      }
      return m;
    };
    const pending = state.pendingMessages[convId];
    if (pending) {
      set({ pendingMessages: { ...state.pendingMessages, [convId]: pending.map(mark) } });
    }
  },

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

  setConversationMeta: sync(function (this: Draft, convId: string, meta: ConversationMeta) {
    this.conversations[convId] = meta;
  }),

  updateConversationMeta: sync(function (this: Draft, convId: string, partial: Record<string, any>) {
    if (!this.conversations[convId]) return;
    Object.assign(this.conversations[convId], partial);
  }),

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


  syncDocDetail: sync(function (this: Draft, id: string, detail: DocDetail) {
    this.docDetails[id] = detail;
  }),

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
    const { sidePanelOpen } = get();
    if (sidePanelOpen) {
      set({ sidePanelOpen: false });
    } else {
      set({ sidePanelOpen: true });
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

  syncTeams: sync(function (this: Draft, teams: any[]) {
    this.teams = teams;
  }),

  syncTeamMembers: sync(function (this: Draft, members: any[]) {
    this.teamMembers = members;
  }),

  syncTeamUnreadCount: sync(function (this: Draft, count: number | null) {
    this.teamUnreadCount = count;
  }),

  syncFavorites: sync(function (this: Draft, favorites: any[]) {
    this.favorites = favorites;
  }),

  syncBookmarks: sync(function (this: Draft, bookmarks: any[]) {
    this.bookmarks = bookmarks;
  }),

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
        if (key === "clientState" && state.clientStateInitialized) continue;
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

    // Critical path: sidebar + current conversation render immediately
    apply(["sessions", "dismissedSessions", "clientState", "messages", "pagination",
           "conversations", "teams", "teamMembers", "teamUnreadCount", "drafts"]);

    // Deferred: list views + secondary data render next frame
    requestAnimationFrame(() => {
      apply(["tasks", "docs", "plans", "favorites", "bookmarks",
             "recentProjects", "collapsedSections", "sidebarNavExpanded"]);
    });
  });
}
