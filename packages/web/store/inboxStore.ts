import { create } from "zustand";
import { mutativeMiddleware, action } from "./mutativeMiddleware";

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
  stableKey?: string;
  implementation_session?: { _id: string; title?: string };
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
};

export type OptimisticMessage = {
  _id: string;
  role: "user";
  content: string;
  timestamp: number;
  _isOptimistic: true;
  images?: Array<{ media_type: string; storage_id?: string }>;
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

export type CurrentConversationContext = {
  conversationId?: string;
  projectPath?: string;
  gitRoot?: string;
  agentType?: string;
  source?: "inbox" | "sessions";
};

export type ClientState = {
  current_conversation_id?: string;
  show_dismissed?: boolean;
  dismissed_ids?: string[];
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
  injectedIds: Set<string>;
  showDismissed: boolean;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;
  mruStack: string[];

  messages: Record<string, Message[]>;
  optimisticMessages: Record<string, OptimisticMessage[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;

  clientState: ClientState;

  pendingPatches: Record<string, Record<string, any>>;
  drafts: Record<string, Record<string, any>>;

  tempIdMap: Record<string, string>;

  currentConversation: CurrentConversationContext;

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
  pinSession: (id: string) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  navigateToSession: (id: string) => void;
  replaceSessionId: (tempId: string, realId: string) => void;
  touchMru: (id: string) => void;

  // -- Message actions --
  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => void;
  mergeMessages: (convId: string, msgs: Message[], direction: "prepend" | "append", meta?: Partial<PaginationState>) => void;
  addOptimisticMessage: (convId: string, content: string, images?: Array<{ media_type: string; storage_id?: string }>) => string;
  removeOptimisticMessage: (convId: string, messageId: string) => void;
  removeMatchingOptimistic: (convId: string, content: string) => void;
  setPagination: (convId: string, update: Partial<PaginationState>) => void;
  initPagination: (convId: string) => void;

  // -- Metadata --
  setConversationMeta: (convId: string, meta: ConversationMeta) => void;
  updateConversationMeta: (convId: string, partial: Record<string, any>) => void;
  setCurrentConversation: (ctx: CurrentConversationContext) => void;
  clearCurrentConversation: () => void;

  // -- Patches (backward compat) --
  patch: (table: string, id: string, fields: Record<string, any>) => void;
  confirmPatch: (id: string) => void;
  applyPatch: <T extends { _id: string }>(doc: T) => T;

  // -- Drafts --
  setDraft: (id: string, fields: Record<string, any>) => void;
  getDraft: (id: string) => Record<string, any> | undefined;
  clearDraft: (id: string) => void;

  // -- Temp ID --
  resolveTempId: (tempId: string, realId: string) => void;
  getRealId: (id: string) => string;

  // -- Selectors --
  getSession: (id: string) => InboxSession | undefined;
  getMergedMessages: (convId: string) => Message[];
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
  return s.replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").replace(/\[image\]/gi, "").trim();
}

export const useInboxStore = create<InboxStoreState>(
  mutativeMiddleware((set: any, get: any) => ({
  // -- Initial state --
  sessions: [],
  dismissedSessions: [],
  currentIndex: 0,
  dismissedIds: new Set(),
  injectedIds: new Set(),
  showDismissed: false,
  viewingDismissedId: null,
  pendingNavigateId: null,
  mruStack: [],

  messages: {},
  optimisticMessages: {},
  pagination: {},
  conversations: {},

  clientState: {},

  pendingPatches: {},
  drafts: {},

  tempIdMap: {},

  currentConversation: {},

  // =====================
  // ACTIONS (wrapped by middleware: mutative draft + server dispatch)
  // Mark with action() to opt in. `this` is a mutative draft.
  // =====================

  stashSession: action(function (this: Draft, id: string) {
    if (this.conversations[id]) {
      this.conversations[id].inbox_dismissed_at = Date.now();
    }
    this.dismissedIds.add(id);
    this.injectedIds.delete(id);
    const idx = this.sessions.findIndex((s: InboxSession) => s._id === id);
    if (idx >= 0) {
      this.sessions.splice(idx, 1);
    }
    if (this.currentIndex >= this.sessions.length) {
      this.currentIndex = Math.max(0, this.sessions.length - 1);
    }
  }),

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
    this.injectedIds.add(convId);
    if (this.conversations[convId]) {
      this.conversations[convId].project_path = path;
      this.conversations[convId].git_root = path;
    }
  }),

  sendMessage: action(function (this: Draft, convId: string, content: string, _imageIds?: string[], images?: Array<{ media_type: string; storage_id?: string }>) {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    if (!this.optimisticMessages[convId]) this.optimisticMessages[convId] = [];
    this.optimisticMessages[convId].push({
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
    const { dismissedIds, currentIndex, sessions: prev, injectedIds, pendingPatches } = get();

    for (const s of incoming) {
      const pending = pendingPatches[s._id];
      if (!pending || Object.entries(pending).every(([k, v]) => (s as any)[k] === v)) {
        if (pending) {
          const next = { ...get().pendingPatches };
          delete next[s._id];
          set({ pendingPatches: next });
        }
      }
    }

    const incomingById = new Map(incoming.map((s) => [s._id, s]));
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

    const merged: InboxSession[] = [];
    const seen = new Set<string>();

    for (const old of prev) {
      if (old._id.startsWith("temp_")) {
        merged.push(old);
        seen.add(old._id);
        continue;
      }
      if (injectedIds.has(old._id) && !dismissedIds.has(old._id)) {
        const fresh = incomingById.get(old._id);
        let resolved = fresh || old;
        resolved = get().applyPatch(resolved as any) as InboxSession;
        merged.push(old.stableKey ? { ...resolved, stableKey: old.stableKey } : resolved);
        seen.add(old._id);
        continue;
      }
      const fresh = incomingById.get(old._id);
      if (fresh && !dismissedIds.has(old._id)) {
        const applied = get().applyPatch(fresh as any) as InboxSession;
        merged.push(old.stableKey ? { ...applied, stableKey: old.stableKey } : applied);
        seen.add(old._id);
      }
    }

    for (const s of visibleIncoming) {
      if (!seen.has(s._id)) {
        merged.push(s);
      }
    }

    merged.sort((a, b) => {
      if (a._id.startsWith("temp_") !== b._id.startsWith("temp_")) {
        return a._id.startsWith("temp_") ? -1 : 1;
      }
      const aNew = a.message_count === 0;
      const bNew = b.message_count === 0;
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
      return 0;
    });

    const currentSession = prev[currentIndex];
    let newIndex = currentIndex;
    if (currentSession) {
      const idx = merged.findIndex((s) => s._id === currentSession._id);
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
    set({ clientState: {
      current_conversation_id: serverState.current_conversation_id,
      show_dismissed: serverState.show_dismissed,
      dismissed_ids: serverState.dismissed_ids,
      sidebar_collapsed: serverState.sidebar_collapsed,
      zen_mode: serverState.zen_mode,
      layout: serverState.layout,
    }});
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
    const { sessions, injectedIds, dismissedIds } = get();
    const next = new Set(injectedIds);
    next.add(session._id);
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(session._id)) {
      get()._dispatch("patch", [], { conversations: { [session._id]: { inbox_dismissed_at: null } } }).catch(() => {});
    }
    set({ sessions: [session, ...sessions], currentIndex: 0, injectedIds: next, dismissedIds: newDismissed, viewingDismissedId: null });
  },

  pinSession: (id: string) => {
    const { injectedIds } = get();
    if (injectedIds.has(id)) return;
    const next = new Set(injectedIds);
    next.add(id);
    set({ injectedIds: next });
  },

  updateSessionProject: (id: string, projectPath: string) => {
    const { sessions, injectedIds } = get();
    const updated = sessions.map((s: InboxSession) =>
      s._id === id ? { ...s, project_path: projectPath, git_root: projectPath } : s
    );
    const next = new Set(injectedIds);
    next.add(id);
    set({ sessions: updated, injectedIds: next });
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

  replaceSessionId: (tempId: string, realId: string) => {
    const { sessions, currentIndex, injectedIds } = get();
    const tempIdx = sessions.findIndex((s: InboxSession) => s._id === tempId);
    if (tempIdx < 0) return;
    const newInjected = new Set(injectedIds);
    newInjected.delete(tempId);
    newInjected.add(realId);
    const realIdx = sessions.findIndex((s: InboxSession) => s._id === realId);
    if (realIdx >= 0) {
      const updated = sessions.filter((s: InboxSession) => s._id !== tempId);
      const realInUpdated = updated.findIndex((s: InboxSession) => s._id === realId);
      if (realInUpdated >= 0 && !updated[realInUpdated].stableKey) {
        updated[realInUpdated] = { ...updated[realInUpdated], stableKey: tempId };
      }
      const newIndex = currentIndex === tempIdx ? (realIdx > tempIdx ? realIdx - 1 : realIdx) : Math.min(currentIndex, updated.length - 1);
      set({ sessions: updated, currentIndex: newIndex, injectedIds: newInjected });
    } else {
      const updated = [...sessions];
      updated[tempIdx] = { ...updated[tempIdx], _id: realId, stableKey: tempId };
      set({ sessions: updated, injectedIds: newInjected });
    }
  },

  // =====================
  // MESSAGE MANAGEMENT
  // =====================

  setMessages: (convId: string, msgs: Message[], meta?: Partial<PaginationState>) => {
    set((s: InboxStoreState) => ({
      messages: { ...s.messages, [convId]: msgs },
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
    const msg: OptimisticMessage = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      ...(images && images.length > 0 ? { images } : {}),
    };
    set((s: InboxStoreState) => ({
      optimisticMessages: {
        ...s.optimisticMessages,
        [convId]: [...(s.optimisticMessages[convId] || []), msg],
      },
    }));
    return id;
  },

  removeOptimisticMessage: (convId: string, messageId: string) => {
    set((s: InboxStoreState) => {
      const current = s.optimisticMessages[convId];
      if (!current) return s;
      return {
        optimisticMessages: {
          ...s.optimisticMessages,
          [convId]: current.filter((m: OptimisticMessage) => m._id !== messageId),
        },
      };
    });
  },

  removeMatchingOptimistic: (convId: string, content: string) => {
    set((s: InboxStoreState) => {
      const current = s.optimisticMessages[convId];
      if (!current) return s;
      const normalize = (str: string) => str.replace(/\[image\]/gi, "").trim();
      const trimmed = normalize(content);
      let removed = false;
      const filtered = current.filter((m: OptimisticMessage) => {
        if (!removed && normalize(m.content) === trimmed) {
          removed = true;
          return false;
        }
        return true;
      });
      if (!removed) return s;
      return {
        optimisticMessages: { ...s.optimisticMessages, [convId]: filtered },
      };
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
  // PATCHES (backward compat, routes through _dispatch)
  // =====================

  patch: (table: string, id: string, fields: Record<string, any>) => {
    const prev = get().pendingPatches[id] || {};
    set((s: InboxStoreState) => ({
      pendingPatches: {
        ...s.pendingPatches,
        [id]: { ...prev, ...fields },
      },
    }));

    get()._dispatch("patch", [], { [table]: { [id]: fields } }).catch(() => {
      const current = get().pendingPatches[id];
      if (!current) return;
      const rolled: Record<string, any> = { ...current };
      for (const key of Object.keys(fields)) {
        if (prev[key] !== undefined) {
          rolled[key] = prev[key];
        } else {
          delete rolled[key];
        }
      }
      if (Object.keys(rolled).length === 0) {
        set((s: InboxStoreState) => {
          const next = { ...s.pendingPatches };
          delete next[id];
          return { pendingPatches: next };
        });
      } else {
        set((s: InboxStoreState) => ({
          pendingPatches: { ...s.pendingPatches, [id]: rolled },
        }));
      }
    });
  },

  confirmPatch: (id: string) => {
    set((s: InboxStoreState) => {
      const next = { ...s.pendingPatches };
      delete next[id];
      return { pendingPatches: next };
    });
  },

  applyPatch: <T extends { _id: string }>(doc: T): T => {
    const pending = get().pendingPatches[doc._id];
    if (!pending) return doc;
    return { ...doc, ...pending };
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
  // TEMP ID
  // =====================

  resolveTempId: (tempId: string, realId: string) => {
    const state = get();

    const newTempIdMap = { ...state.tempIdMap, [tempId]: realId };

    const newMessages = { ...state.messages };
    if (newMessages[tempId]) {
      newMessages[realId] = newMessages[tempId];
      delete newMessages[tempId];
    }

    const newOptimistic = { ...state.optimisticMessages };
    if (newOptimistic[tempId]) {
      newOptimistic[realId] = newOptimistic[tempId];
      delete newOptimistic[tempId];
    }

    const newPagination = { ...state.pagination };
    if (newPagination[tempId]) {
      newPagination[realId] = newPagination[tempId];
      delete newPagination[tempId];
    }

    const newConversations = { ...state.conversations };
    if (newConversations[tempId]) {
      newConversations[realId] = { ...newConversations[tempId], _id: realId };
      delete newConversations[tempId];
    }

    const newDrafts = { ...state.drafts };
    if (newDrafts[tempId]) {
      newDrafts[realId] = newDrafts[tempId];
      delete newDrafts[tempId];
    }

    set({
      tempIdMap: newTempIdMap,
      messages: newMessages,
      optimisticMessages: newOptimistic,
      pagination: newPagination,
      conversations: newConversations,
      drafts: newDrafts,
    });
  },

  getRealId: (id: string) => {
    return get().tempIdMap[id] || id;
  },

  // =====================
  // SELECTORS
  // =====================

  getSession: (id: string) => {
    const { sessions, dismissedSessions } = get();
    const s = sessions.find((s: InboxSession) => s._id === id) || dismissedSessions.find((s: InboxSession) => s._id === id);
    return s ? get().applyPatch(s as any) as InboxSession : undefined;
  },

  getMergedMessages: (convId: string) => {
    const { messages, optimisticMessages } = get();
    const cached = messages[convId] || [];
    const optimistic = optimisticMessages[convId] || [];
    if (optimistic.length === 0) return cached;
    const existingContents = new Set(
      cached
        .filter((m: Message) => m.role === "user" && m.content)
        .map((m: Message) => stripImageRef(m.content!))
    );
    const fresh = optimistic.filter(
      (m: OptimisticMessage) => !existingContents.has(stripImageRef(m.content))
    );
    if (fresh.length === 0) return cached;
    return [...cached, ...fresh].sort((a: Message, b: Message) => a.timestamp - b.timestamp);
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
