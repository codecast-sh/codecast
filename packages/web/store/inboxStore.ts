import { create } from "zustand";
import { mutativeMiddleware, action } from "./mutativeMiddleware";

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

// -- Store interface --

interface InboxStoreState {
  sessions: InboxSession[];
  dismissedSessions: InboxSession[];
  currentIndex: number;
  dismissedIds: Set<string>;
  showDismissed: boolean;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;
  mruStack: string[];

  messages: Record<string, Message[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;

  clientState: ClientState;

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
  switchProject: (convId: string, path: string) => void;
  sendMessage: (convId: string, content: string, imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) => Promise<any>;
  resumeSession: (convId: string) => Promise<any>;
  sendEscape: (convId: string) => void;
  createSession: (opts: { agent_type: string; project_path?: string; git_root?: string }) => Promise<any>;

  // -- Local actions --
  advanceToNext: () => void;
  syncSessionsFromConvex: (incoming: InboxSession[]) => void;
  syncDismissedFromConvex: (incoming: InboxSession[]) => void;
  syncClientState: (state: any) => void;
  navigateUp: () => void;
  navigateDown: () => void;
  setCurrentIndex: (index: number) => void;
  setShowDismissed: (show: boolean) => void;
  setViewingDismissedId: (id: string | null) => void;
  getCurrentSession: () => InboxSession | null;
  injectSession: (session: InboxSession) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  patchSession: (id: string, fields: Partial<InboxSession>) => void;
  navigateToSession: (id: string) => void;
  touchMru: (id: string) => void;

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
  sessions: [],
  dismissedSessions: [],
  currentIndex: 0,
  dismissedIds: new Set(),
  showDismissed: false,
  viewingDismissedId: null,
  pendingNavigateId: null,
  mruStack: [],

  messages: {},
  pagination: {},
  conversations: {},

  clientState: {},

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
  // Mark with action() to opt in. `this` is a mutative draft.
  // =====================

  stashSession: (id: string) => {
    const { sessions, dismissedIds, currentIndex, conversations } = get();
    const newDismissed = new Set(dismissedIds);
    newDismissed.add(id);
    const newSessions = sessions.filter((s: InboxSession) => s._id !== id);
    const newConversations = { ...conversations };
    if (newConversations[id]) {
      newConversations[id] = { ...newConversations[id], inbox_dismissed_at: Date.now() };
    }
    const newIndex = currentIndex >= newSessions.length
      ? Math.max(0, newSessions.length - 1)
      : currentIndex;
    set({
      sessions: newSessions,
      dismissedIds: newDismissed,
      currentIndex: newIndex,
      conversations: newConversations,
    });
    get()._dispatch("patch", [], {
      conversations: { [id]: { inbox_dismissed_at: Date.now() } },
    }).catch(() => {});
  },

  unstashSession: action(function (this: Draft, id: string) {
    if (this.conversations[id]) {
      this.conversations[id].inbox_dismissed_at = null;
    }
    this.dismissedIds.delete(id);
  }),

  deferSession: action(function (this: Draft, id: string) {
    if (this.conversations[id]) {
      this.conversations[id].inbox_deferred_at = Date.now();
    }
    const idx = this.sessions.findIndex((s: InboxSession) => s._id === id);
    if (idx < 0 || this.sessions.length <= 1) return;
    const session = { ...this.sessions[idx], is_deferred: true };
    this.sessions.splice(idx, 1);
    this.sessions.push(session as any);
    if (idx < this.currentIndex) this.currentIndex--;
    if (this.currentIndex >= this.sessions.length) {
      this.currentIndex = Math.max(0, this.sessions.length - 1);
    }
  }),

  switchProject: action(function (this: Draft, convId: string, path: string) {
    const idx = this.sessions.findIndex((s: InboxSession) => s._id === convId);
    if (idx >= 0) {
      this.sessions[idx].project_path = path;
      this.sessions[idx].git_root = path;
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
  // LOCAL METHODS (plain set/get, NOT wrapped by middleware)
  // =====================

  advanceToNext: () => {
    const { sessions, currentIndex } = get();
    const idleSessions = sessions.filter((s: InboxSession) => s.is_idle);
    const currentId = sessions[currentIndex]?._id;
    const currentIdleIdx = idleSessions.findIndex((s: InboxSession) => s._id === currentId);
    const nextIdle = idleSessions[currentIdleIdx + 1] || idleSessions[0];
    if (nextIdle && nextIdle._id !== currentId) {
      const globalIdx = sessions.findIndex((s: InboxSession) => s._id === nextIdle._id);
      if (globalIdx >= 0) set({ currentIndex: globalIdx });
    }
  },

  syncSessionsFromConvex: (incoming: InboxSession[]) => {
    const { dismissedIds, currentIndex, sessions: prev } = get();

    const incomingById = new Map(incoming.map((s) => [s._id, s]));
    const incomingBySessionId = new Map(incoming.map((s) => [s.session_id, s]));

    // dismissedIds is purely optimistic — clear any ID the server returned as active.
    let dismissedChanged = false;
    for (const id of dismissedIds) {
      if (incomingById.has(id)) {
        dismissedIds.delete(id);
        dismissedChanged = true;
      }
    }
    if (dismissedChanged) set({ dismissedIds: new Set(dismissedIds) });

    const visibleIncoming = incoming.filter((s) => !dismissedIds.has(s._id));

    const newConversations = { ...get().conversations };
    for (const s of incoming) {
      if (!newConversations[s._id]) {
        newConversations[s._id] = { _id: s._id };
      }
    }

    if (prev.length === 0) {
      const clampedIndex = Math.min(currentIndex, Math.max(0, visibleIncoming.length - 1));
      set({ sessions: visibleIncoming, currentIndex: clampedIndex, conversations: newConversations });
      return;
    }

    const currentSession = prev[currentIndex];
    const merged: InboxSession[] = [];
    const seen = new Set<string>();

    for (const old of prev) {
      if (!isConvexId(old._id)) {
        const serverMatch = incomingBySessionId.get(old.session_id || old._id);
        if (serverMatch) {
          get().resolveSessionId(old._id, serverMatch._id);
          merged.push(serverMatch);
          seen.add(serverMatch._id);
        } else {
          merged.push(old);
          seen.add(old._id);
        }
        continue;
      }
      const fresh = incomingById.get(old._id);
      if (fresh && !dismissedIds.has(old._id)) {
        merged.push(fresh);
        seen.add(old._id);
      } else if (old._id === currentSession?._id && !dismissedIds.has(old._id)) {
        merged.push(old);
        seen.add(old._id);
      }
    }

    for (const s of visibleIncoming) {
      if (!seen.has(s._id)) {
        merged.push(s);
      }
    }

    merged.sort((a, b) => {
      if (!isConvexId(a._id) !== !isConvexId(b._id)) {
        return !isConvexId(a._id) ? -1 : 1;
      }
      const aNew = a.message_count === 0;
      const bNew = b.message_count === 0;
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
      return 0;
    });

    let newIndex = currentIndex;
    if (currentSession) {
      const matchId = isConvexId(currentSession._id)
        ? currentSession._id
        : incomingBySessionId.get(currentSession.session_id || currentSession._id)?._id || currentSession._id;
      const idx = merged.findIndex((s) => s._id === matchId);
      newIndex = idx >= 0 ? idx : Math.min(currentIndex, Math.max(0, merged.length - 1));
    } else {
      newIndex = Math.min(currentIndex, Math.max(0, merged.length - 1));
    }

    set({ sessions: merged, currentIndex: newIndex, conversations: newConversations });
  },

  syncDismissedFromConvex: (incoming: InboxSession[]) => {
    set({ dismissedSessions: incoming });
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
    set({ clientState: cs });
  },

  navigateUp: () => {
    const { sessions, currentIndex } = get();
    if (sessions.length === 0) return;
    set({ currentIndex: (currentIndex - 1 + sessions.length) % sessions.length });
  },

  navigateDown: () => {
    const { sessions, currentIndex } = get();
    if (sessions.length === 0) return;
    set({ currentIndex: (currentIndex + 1) % sessions.length });
  },

  setCurrentIndex: (index: number) => {
    const { sessions } = get();
    if (index >= 0 && index < sessions.length) {
      set({ currentIndex: index, viewingDismissedId: null });
    }
  },

  setShowDismissed: (show: boolean) => {
    set({ showDismissed: show });
  },

  setViewingDismissedId: (id: string | null) => {
    set({ viewingDismissedId: id });
  },

  getCurrentSession: () => {
    const { sessions, currentIndex } = get();
    return sessions[currentIndex] ?? null;
  },

  injectSession: (session: InboxSession) => {
    const { sessions, dismissedIds } = get();
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(session._id)) {
      get()._dispatch("patch", [], { conversations: { [session._id]: { inbox_dismissed_at: null } } }).catch(() => {});
    }
    set({ sessions: [session, ...sessions], currentIndex: 0, dismissedIds: newDismissed, viewingDismissedId: null });
  },

  updateSessionProject: (id: string, projectPath: string) => {
    const { sessions } = get();
    const updated = sessions.map((s: InboxSession) =>
      s._id === id ? { ...s, project_path: projectPath, git_root: projectPath } : s
    );
    set({ sessions: updated });
  },

  patchSession: (id: string, fields: Partial<InboxSession>) => {
    const { sessions } = get();
    const updated = sessions.map((s: InboxSession) =>
      s._id === id ? { ...s, ...fields } : s
    );
    set({ sessions: updated });
  },

  navigateToSession: (id: string) => {
    const { sessions, dismissedIds } = get();
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(id)) {
      get()._dispatch("patch", [], { conversations: { [id]: { inbox_dismissed_at: null } } }).catch(() => {});
      set({ dismissedIds: newDismissed });
    }
    const idx = sessions.findIndex((s: InboxSession) => s._id === id);
    if (idx >= 0) {
      set({ currentIndex: idx, viewingDismissedId: null });
    } else {
      set({ pendingNavigateId: id, viewingDismissedId: null });
    }
  },

  touchMru: (id: string) => {
    const { mruStack } = get();
    const filtered = mruStack.filter((s: string) => s !== id);
    set({ mruStack: [id, ...filtered] });
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
    const session = get().sessions.find((s: InboxSession) => s.session_id === id || s._id === id);
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
  // SELECTORS
  // =====================

  getSession: (id: string) => {
    const { sessions, dismissedSessions } = get();
    return sessions.find((s: InboxSession) => s._id === id) || dismissedSessions.find((s: InboxSession) => s._id === id);
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
