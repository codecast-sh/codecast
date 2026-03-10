import { create } from "zustand";
import { mutativeMiddleware, action } from "./mutativeMiddleware";
import { applySyncTable, type PendingEntry } from "./syncProtocol";

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
  agent_status?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected";
  is_deferred?: boolean;
  is_pinned?: boolean;
  last_user_message?: string | null;
  session_error?: string;
  implementation_session?: { _id: string; title?: string };
  is_subagent?: boolean;
  parent_conversation_id?: string;
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

export type TaskItem = {
  _id: string;
  short_id: string;
  title: string;
  description?: string;
  task_type: string;
  status: string;
  priority: string;
  source: string;
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
};

export type TaskDetail = TaskItem & {
  comments?: any[];
  linked_conversations?: any[];
  related_docs?: any[];
  source_insight?: any;
  creator?: { _id: string; name: string; image?: string };
  history?: any[];
  created_from_conversation?: string;
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
  created_at: number;
  updated_at: number;
};

export type DocDetail = DocItem & {
  conversation?: any;
  related_tasks?: any[];
  related_sessions?: any[];
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
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.is_deferred !== b.is_deferred) return a.is_deferred ? 1 : -1;
    if (!isConvexId(a._id) !== !isConvexId(b._id)) return !isConvexId(a._id) ? -1 : 1;
    const aNew = a.message_count === 0;
    const bNew = b.message_count === 0;
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
    return 0;
  });
  return list;
}

// -- Store interface --

interface InboxStoreState {
  sessions: Record<string, InboxSession>;
  dismissedSessions: Record<string, InboxSession>;
  pending: Record<string, PendingEntry>;
  currentSessionId: string | null;
  showDismissed: boolean;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;
  showMySessions: boolean;
  setShowMySessions: (show: boolean) => void;
  mruStack: string[];

  messages: Record<string, Message[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;

  clientState: ClientState;
  clientStateInitialized: boolean;

  drafts: Record<string, Record<string, any>>;

  currentConversation: CurrentConversationContext;

  // -- New session modal --
  newSession: { isOpen: boolean; context: SessionContext };
  openNewSession: (ctx?: SessionContext) => void;
  closeNewSession: () => void;

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
  switchProject: (convId: string, path: string) => void;
  sendMessage: (convId: string, content: string, imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) => Promise<any>;
  resumeSession: (convId: string) => Promise<any>;
  sendEscape: (convId: string) => void;
  createSession: (opts: { agent_type: string; project_path?: string; git_root?: string }) => Promise<any>;

  // -- Generic sync --
  syncTable: (tableName: string, incoming: Array<{ _id: string; [k: string]: any }>, extra?: Record<string, any>) => void;
  syncRecord: (tableName: string, id: string, record: any) => void;
  syncClientState: (state: any) => void;
  addPending: (key: string, entry: PendingEntry) => void;
  clearPending: (key: string) => void;
  sortedSessions: () => InboxSession[];

  // -- Navigation --
  advanceToNext: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  setCurrentSession: (id: string) => void;
  clearSelection: () => void;
  setShowDismissed: (show: boolean) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  navigateToSession: (id: string) => void;
  touchMru: (id: string) => void;
  markKilling: (id: string) => void;

  // -- Message actions --
  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => void;
  mergeMessages: (convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) => void;
  addOptimisticMessage: (convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => string;
  markOptimisticAsQueued: (convId: string, content: string) => void;
  setPagination: (convId: string, update: Partial<PaginationState>) => void;
  initPagination: (convId: string) => void;

  // -- Metadata --
  setConversationMeta: (convId: string, meta: ConversationMeta) => void;
  updateConversationMeta: (convId: string, partial: Record<string, any>) => void;
  setCurrentConversation: (ctx: CurrentConversationContext) => void;
  clearCurrentConversation: () => void;

  // -- Drafts --
  setDraft: (id: string, fields: Record<string, any>) => void;
  getDraft: (id: string) => Record<string, any> | undefined;
  clearDraft: (id: string) => void;

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

  // -- Task / Doc state --
  tasks: Record<string, TaskItem>;
  docs: Record<string, DocItem>;
  docProjectPaths: string[];
  taskDetails: Record<string, TaskDetail>;
  docDetails: Record<string, DocDetail>;
  taskFilter: { status: string };
  docFilter: { type: string; query: string; project: string; scope: string };

  // -- Task / Doc detail sync --
  syncTaskDetail: (id: string, detail: TaskDetail) => void;
  syncDocDetail: (id: string, detail: DocDetail) => void;
  setTaskFilter: (filter: Partial<{ status: string }>) => void;
  setDocFilter: (filter: Partial<{ type: string; query: string; project: string; scope: string }>) => void;

  // -- Task / Doc mutations (action + side effect) --
  updateTaskStatus: (shortId: string, status: string) => Promise<any>;
  updateTask: (shortId: string, fields: { status?: string; priority?: string; title?: string; description?: string; labels?: string[] }) => Promise<any>;
  createTask: (opts: { title: string; description?: string; task_type?: string; priority?: string; status?: string; project_id?: string; labels?: string[] }) => Promise<any>;
  addTaskComment: (shortId: string, text: string, commentType?: string) => Promise<any>;
  pinDoc: (id: string, pinned: boolean) => Promise<any>;
  archiveDoc: (id: string) => Promise<any>;

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

export const useInboxStore = create<InboxStoreState>(
  mutativeMiddleware((set: any, get: any) => ({
  // -- Initial state --
  sessions: {},
  dismissedSessions: {},
  pending: {},
  currentSessionId: null,
  showDismissed: false,
  viewingDismissedId: null,
  pendingNavigateId: null,
  showMySessions: false,
  setShowMySessions: (show: boolean) => set({ showMySessions: show }),
  mruStack: [],

  messages: {},
  pagination: {},
  conversations: {},

  clientState: {},
  clientStateInitialized: false,

  drafts: {},

  currentConversation: {},

  newSession: { isOpen: false, context: {} },

  openNewSession: (ctx?: SessionContext) => {
    set({ newSession: { isOpen: true, context: ctx || {} } });
  },

  closeNewSession: () => {
    set({ newSession: { isOpen: false, context: {} } });
  },

  activeBranches: {},
  optimisticForkChildren: [],

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // =====================

  stashSession: (id: string) => {
    const state = get();
    const newSessions = { ...state.sessions };
    delete newSessions[id];
    const newPending = { ...state.pending };
    newPending[`sessions:${id}`] = { type: "exclude", expiresAt: Date.now() + 15_000 };
    const newConversations = { ...state.conversations };
    if (newConversations[id]) {
      newConversations[id] = { ...newConversations[id], inbox_dismissed_at: Date.now() };
    }
    let newSessionId = state.currentSessionId;
    if (state.currentSessionId === id) {
      const sorted = sortSessions(newSessions);
      newSessionId = sorted.find((s) => !s.is_pinned)?._id ?? sorted[0]?._id ?? null;
    }
    set({
      sessions: newSessions,
      pending: newPending,
      conversations: newConversations,
      currentSessionId: newSessionId,
    });
    get()._dispatch("patch", [], {
      conversations: { [id]: { inbox_dismissed_at: Date.now() } },
    }).catch(() => {});
  },

  unstashSession: action(function (this: Draft, id: string) {
    if (this.conversations[id]) {
      this.conversations[id].inbox_dismissed_at = null;
    }
    delete this.pending[`sessions:${id}`];
  }),

  deferSession: action(function (this: Draft, id: string) {
    if (this.conversations[id]) {
      this.conversations[id].inbox_deferred_at = Date.now();
    }
    if (this.sessions[id]) {
      this.sessions[id].is_deferred = true;
    }
  }),

  pinSession: action(function (this: Draft, id: string) {
    const isPinned = this.sessions[id]?.is_pinned;
    if (this.conversations[id]) {
      this.conversations[id].inbox_pinned_at = isPinned ? null : Date.now();
    }
    if (this.sessions[id]) {
      this.sessions[id].is_pinned = !isPinned;
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

  sendMessage: action(function (this: Draft, convId: string, content: string, _imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (!this.messages[convId]) this.messages[convId] = [];
    this.messages[convId].push({
      _id: id,
      role: "user" as const,
      content,
      timestamp: Date.now(),
      _isOptimistic: true as const,
      ...(images && images.length > 0 ? { images } : {}),
    });
  }),

  resumeSession: action(function (_convId: string) {}),

  sendEscape: action(function (_convId: string) {}),

  createSession: action(function (_opts: { agent_type: string; project_path?: string; git_root?: string }) {}),

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

  syncTable: (tableName: string, incoming: Array<{ _id: string; [k: string]: any }>, extra?: Record<string, any>) => {
    const state = get();
    const { table, pending } = applySyncTable(tableName, incoming as any, state.pending);

    if (tableName === "sessions") {
      const prev = state.sessions as Record<string, InboxSession>;
      const incomingBySessionId = new Map(incoming.map((s: any) => [s.session_id, s]));
      for (const [oldId, oldSession] of Object.entries(prev)) {
        if (isConvexId(oldId)) continue;
        const match = incomingBySessionId.get((oldSession as InboxSession).session_id || oldId);
        if (match) {
          get().resolveSessionId(oldId, match._id);
          if (state.currentSessionId === oldId) {
            set({ currentSessionId: match._id });
          }
        } else if (!table[oldId]) {
          table[oldId] = oldSession as any;
        }
      }
      const newConversations = { ...state.conversations };
      for (const s of incoming) {
        if (!newConversations[s._id]) {
          newConversations[s._id] = { _id: s._id };
        }
      }
      if (!state.currentSessionId && Object.keys(table).length > 0) {
        const sorted = sortSessions(table as Record<string, InboxSession>);
        set({ sessions: table, pending, conversations: newConversations, currentSessionId: sorted[0]?._id ?? null });
      } else {
        set({ sessions: table, pending, conversations: newConversations });
      }
      return;
    }

    const updates: any = { [tableName]: table, pending };
    if (extra) Object.assign(updates, extra);
    set(updates);
  },

  syncRecord: (tableName: string, id: string, record: any) => {
    set((s: InboxStoreState) => ({
      [tableName]: { ...(s as any)[tableName], [id]: record },
    }));
  },

  syncClientState: (serverState: any) => {
    if (!serverState) return;
    const prev = get().clientState;
    const cs: ClientState = {
      current_conversation_id: serverState.current_conversation_id,
      show_dismissed: serverState.show_dismissed,
      dismissed_ids: serverState.dismissed_ids,
      ui: serverState.ui ?? {
        sidebar_collapsed: serverState.sidebar_collapsed,
        zen_mode: serverState.zen_mode,
      },
      layouts: serverState.layouts ?? (serverState.layout ? {
        dashboard: serverState.layout,
      } : undefined),
      dismissed: { ...prev.dismissed, ...serverState.dismissed },
    };
    set({ clientState: cs, clientStateInitialized: true });
  },

  addPending: (key: string, entry: PendingEntry) => {
    set((s: InboxStoreState) => ({
      pending: { ...s.pending, [key]: entry },
    }));
  },

  clearPending: (key: string) => {
    set((s: InboxStoreState) => {
      const next = { ...s.pending };
      delete next[key];
      return { pending: next };
    });
  },

  sortedSessions: () => {
    return sortSessions(get().sessions);
  },

  // =====================
  // NAVIGATION
  // =====================

  advanceToNext: () => {
    const sorted = get().sortedSessions();
    const currentId = get().currentSessionId;
    const idleSessions = sorted.filter((s: InboxSession) => s.is_idle && !s.is_pinned);
    const currentIdleIdx = idleSessions.findIndex((s: InboxSession) => s._id === currentId);
    const nextIdle = idleSessions[currentIdleIdx + 1] || idleSessions[0];
    if (nextIdle && nextIdle._id !== currentId) {
      set({ currentSessionId: nextIdle._id });
    }
  },

  navigateUp: () => {
    const sorted = get().sortedSessions();
    if (sorted.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = sorted.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = (idx - 1 + sorted.length) % sorted.length;
    set({ currentSessionId: sorted[newIdx]._id });
  },

  navigateDown: () => {
    const sorted = get().sortedSessions();
    if (sorted.length === 0) return;
    const currentId = get().currentSessionId;
    const idx = sorted.findIndex((s: InboxSession) => s._id === currentId);
    const newIdx = (idx + 1) % sorted.length;
    set({ currentSessionId: sorted[newIdx]._id });
  },

  setCurrentSession: (id: string) => {
    set({ currentSessionId: id, viewingDismissedId: null });
  },

  clearSelection: () => {
    set({ currentSessionId: null, viewingDismissedId: null });
  },

  setShowDismissed: (show: boolean) => {
    set({ showDismissed: show });
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
      set({ currentSessionId: id, viewingDismissedId: null });
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
      const sorted = sortSessions(newSessions);
      newSessionId = sorted.find((s) => !s.is_pinned)?._id ?? sorted[0]?._id ?? null;
    }
    set({ sessions: newSessions, pending: newPending, currentSessionId: newSessionId });
  },


  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => {
    const existing = get().messages[convId] || [];
    const localMsgs = existing.filter((m: Message) => m._isOptimistic || m._isQueued);
    let finalMsgs = msgs;
    if (localMsgs.length > 0) {
      const serverContents = new Set(
        msgs.filter((m: Message) => m.role === "user" && m.content)
          .map((m: Message) => stripImageRef(m.content!))
      );
      const surviving = localMsgs.filter(
        (m: Message) => !serverContents.has(stripImageRef(m.content || ""))
      );
      if (surviving.length > 0) {
        finalMsgs = [...msgs, ...surviving].sort((a: Message, b: Message) => a.timestamp - b.timestamp);
      }
    }
    set((s: InboxStoreState) => ({
      messages: { ...s.messages, [convId]: finalMsgs },
      pagination: {
        ...s.pagination,
        [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...meta },
      },
    }));
  },

  mergeMessages: (convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) => {
    set((s: InboxStoreState) => {
      const existing = s.messages[convId] || [];
      const existingIds = new Set(existing.map((m: Message) => m._id));
      const unique = msgs.filter((m: Message) => !existingIds.has(m._id));
      if (unique.length === 0 && !meta) return s;

      const merged = direction === "prepend"
        ? [...unique, ...existing]
        : [...existing, ...unique];
      merged.sort((a: Message, b: Message) => a.timestamp - b.timestamp);

      return {
        messages: { ...s.messages, [convId]: merged },
        pagination: meta
          ? { ...s.pagination, [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...meta } }
          : s.pagination,
      };
    });
  },

  addOptimisticMessage: (convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg: Message = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      ...(images && images.length > 0 ? { images } : {}),
    };
    set((s: InboxStoreState) => ({
      messages: { ...s.messages, [convId]: [...(s.messages[convId] || []), msg] },
    }));
    return id;
  },

  markOptimisticAsQueued: (convId: string, content: string) => {
    set((s: InboxStoreState) => {
      const msgs = s.messages[convId];
      if (!msgs) return s;
      const stripped = stripImageRef(content);
      const updated = msgs.map((m: Message) => {
        if (m._isOptimistic && m.role === "user" && stripImageRef(m.content || "") === stripped) {
          const { _isOptimistic, ...rest } = m;
          return { ...rest, _isQueued: true as const };
        }
        return m;
      });
      return { messages: { ...s.messages, [convId]: updated } };
    });
  },

  setPagination: (convId: string, update: Partial<PaginationState>) => {
    set((s: InboxStoreState) => ({
      pagination: {
        ...s.pagination,
        [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...update },
      },
    }));
  },

  initPagination: (convId: string) => {
    const existing = get().pagination[convId];
    if (existing) return;
    set((s: InboxStoreState) => ({
      pagination: { ...s.pagination, [convId]: { ...DEFAULT_PAGINATION } },
    }));
  },

  // =====================
  // METADATA
  // =====================

  setConversationMeta: (convId: string, meta: ConversationMeta) => {
    set((s: InboxStoreState) => ({
      conversations: { ...s.conversations, [convId]: meta },
    }));
  },

  updateConversationMeta: (convId: string, partial: Record<string, any>) => {
    set((s: InboxStoreState) => {
      const prev = s.conversations[convId];
      if (!prev) return s;
      return {
        conversations: { ...s.conversations, [convId]: { ...prev, ...partial } },
      };
    });
  },

  setCurrentConversation: (ctx: CurrentConversationContext) => {
    set({ currentConversation: ctx });
  },

  clearCurrentConversation: () => {
    set({ currentConversation: {} });
  },

  // =====================
  // DRAFTS
  // =====================

  setDraft: (id: string, fields: Record<string, any>) => {
    set((s: InboxStoreState) => ({
      drafts: { ...s.drafts, [id]: fields },
    }));
  },

  getDraft: (id: string) => {
    return get().drafts[id];
  },

  clearDraft: (id: string) => {
    set((s: InboxStoreState) => {
      const next = { ...s.drafts };
      delete next[id];
      return { drafts: next };
    });
  },

  // =====================
  // SESSION ID RESOLUTION
  // =====================

  resolveSessionId: (sessionId: string, convexId: string) => {
    if (sessionId === convexId) return;
    const state = get();

    const rekey = <T>(map: Record<string, T>): Record<string, T> | null => {
      if (!map[sessionId]) return null;
      const next = { ...map };
      next[convexId] = next[sessionId];
      delete next[sessionId];
      return next;
    };

    const updates: Partial<InboxStoreState> = {};
    const m = rekey(state.messages); if (m) updates.messages = m as any;
    const p = rekey(state.pagination); if (p) updates.pagination = p as any;
    const d = rekey(state.drafts); if (d) updates.drafts = d as any;

    if (state.conversations[sessionId]) {
      updates.conversations = { ...state.conversations };
      (updates.conversations as any)[convexId] = { ...state.conversations[sessionId], _id: convexId };
      delete (updates.conversations as any)[sessionId];
    }

    if (Object.keys(updates).length > 0) set(updates);
  },

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

  tasks: {},
  docs: {},
  taskDetails: {},
  docDetails: {},
  taskFilter: { status: "" },
  docFilter: { type: "", query: "", project: "", scope: "" },
  docProjectPaths: [],

  syncTaskDetail: (id: string, detail: TaskDetail) => {
    set((s: InboxStoreState) => ({
      taskDetails: { ...s.taskDetails, [id]: detail },
    }));
  },

  syncDocDetail: (id: string, detail: DocDetail) => {
    set((s: InboxStoreState) => ({
      docDetails: { ...s.docDetails, [id]: detail },
    }));
  },

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
    for (const detail of Object.values(this.taskDetails)) {
      if ((detail as TaskDetail).short_id === shortId) {
        (detail as TaskDetail).status = status;
        (detail as TaskDetail).updated_at = Date.now();
        if (status === "done" || status === "dropped") {
          (detail as TaskDetail).closed_at = Date.now();
        }
      }
    }
  }),

  updateTask: action(function (this: Draft, shortId: string, fields: Record<string, any>) {
    const task = Object.values(this.tasks).find((t: any) => t.short_id === shortId) as TaskItem | undefined;
    if (task) {
      Object.assign(task, fields, { updated_at: Date.now() });
    }
    for (const detail of Object.values(this.taskDetails)) {
      if ((detail as TaskDetail).short_id === shortId) {
        Object.assign(detail as TaskDetail, fields, { updated_at: Date.now() });
      }
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
    for (const detail of Object.values(this.taskDetails)) {
      if ((detail as TaskDetail).short_id === shortId && (detail as TaskDetail).comments) {
        (detail as TaskDetail).comments!.push({
          _id: `temp_${Date.now()}`,
          author: "You",
          text,
          comment_type: commentType || "note",
          created_at: Date.now(),
        });
      }
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
