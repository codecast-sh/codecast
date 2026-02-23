import { create } from "zustand";

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
  agent_status?: "working" | "idle" | "permission_blocked";
  is_deferred?: boolean;
  last_user_message?: string | null;
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

type MutationFn = (id: string, fields: Record<string, any>) => Promise<any>;

// -- Store interface --

interface InboxStoreState {
  // Session management
  sessions: InboxSession[];
  dismissedSessions: InboxSession[];
  currentIndex: number;
  dismissedIds: Set<string>;
  injectedIds: Set<string>;
  showDismissed: boolean;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;

  // Messages
  messages: Record<string, Message[]>;
  optimisticMessages: Record<string, OptimisticMessage[]>;
  pagination: Record<string, PaginationState>;
  conversations: Record<string, ConversationMeta>;

  // Patches, mutations, drafts
  pendingPatches: Record<string, Record<string, any>>;
  mutations: Record<string, MutationFn>;
  drafts: Record<string, Record<string, any>>;

  // Temp ID resolution
  tempIdMap: Record<string, string>;

  // Current conversation
  currentConversation: CurrentConversationContext;

  // -- Session actions --
  syncSessionsFromConvex: (incoming: InboxSession[]) => void;
  syncDismissedFromConvex: (incoming: InboxSession[]) => void;
  advanceToNext: () => void;
  stashSession: (id: string) => void;
  unstashSession: (id: string) => void;
  deferSession: (id: string) => void;
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

  // -- Patches --
  patch: (table: string, id: string, fields: Record<string, any>) => void;
  confirmPatch: (id: string) => void;
  applyPatch: <T extends { _id: string }>(doc: T) => T;
  registerMutation: (table: string, fn: MutationFn) => void;

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

export const useInboxStore = create<InboxStoreState>((set, get) => ({
  // -- Initial state --
  sessions: [],
  dismissedSessions: [],
  currentIndex: 0,
  dismissedIds: new Set(),
  injectedIds: new Set(),
  showDismissed: false,
  viewingDismissedId: null,
  pendingNavigateId: null,

  messages: {},
  optimisticMessages: {},
  pagination: {},
  conversations: {},

  pendingPatches: {},
  mutations: {},
  drafts: {},

  tempIdMap: {},

  currentConversation: {},

  // =====================
  // SESSION MANAGEMENT
  // =====================

  syncSessionsFromConvex: (incoming) => {
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

    if (prev.length === 0) {
      const clampedIndex = Math.min(currentIndex, Math.max(0, visibleIncoming.length - 1));
      set({ sessions: visibleIncoming, currentIndex: clampedIndex });
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

    set({ sessions: merged, currentIndex: newIndex });
  },

  syncDismissedFromConvex: (incoming) => {
    set({ dismissedSessions: incoming });
  },

  advanceToNext: () => {
    const { sessions, currentIndex } = get();
    const idleSessions = sessions.filter((s) => s.is_idle);
    const currentId = sessions[currentIndex]?._id;
    const currentIdleIdx = idleSessions.findIndex((s) => s._id === currentId);
    const nextIdle = idleSessions[currentIdleIdx + 1] || idleSessions[0];
    if (nextIdle && nextIdle._id !== currentId) {
      const globalIdx = sessions.findIndex((s) => s._id === nextIdle._id);
      if (globalIdx >= 0) set({ currentIndex: globalIdx });
    }
  },

  stashSession: (id) => {
    const { sessions, currentIndex, dismissedIds, injectedIds } = get();
    const newDismissed = new Set(dismissedIds);
    newDismissed.add(id);
    const newInjected = new Set(injectedIds);
    newInjected.delete(id);

    const visible = sessions.filter((s) => !newDismissed.has(s._id));
    const newIndex = Math.min(currentIndex, Math.max(0, visible.length - 1));
    set({ dismissedIds: newDismissed, injectedIds: newInjected, sessions: visible, currentIndex: newIndex });

    get().patch("conversations", id, { inbox_dismissed_at: Date.now() });
  },

  unstashSession: (id) => {
    const { dismissedIds } = get();
    const newDismissed = new Set(dismissedIds);
    newDismissed.delete(id);
    set({ dismissedIds: newDismissed });

    get().patch("conversations", id, { inbox_dismissed_at: null });
  },

  deferSession: (id) => {
    const { sessions, currentIndex } = get();
    const idx = sessions.findIndex((s) => s._id === id);
    if (idx < 0 || sessions.length <= 1) return;
    const session = { ...sessions[idx], is_deferred: true };
    const updated = [...sessions];
    updated.splice(idx, 1);
    updated.push(session);
    let newIndex = currentIndex;
    if (idx < currentIndex) newIndex--;
    set({ sessions: updated, currentIndex: Math.min(Math.max(0, newIndex), updated.length - 1) });

    get().patch("conversations", id, { inbox_deferred_at: Date.now() });
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

  setCurrentIndex: (index) => {
    const { sessions } = get();
    if (index >= 0 && index < sessions.length) {
      set({ currentIndex: index, viewingDismissedId: null });
    }
  },

  setShowDismissed: (show) => {
    set({ showDismissed: show });
  },

  setViewingDismissedId: (id) => {
    set({ viewingDismissedId: id });
  },

  getCurrentSession: () => {
    const { sessions, currentIndex } = get();
    return sessions[currentIndex] ?? null;
  },

  injectSession: (session) => {
    const { sessions, injectedIds, dismissedIds } = get();
    const next = new Set(injectedIds);
    next.add(session._id);
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(session._id)) {
      get().patch("conversations", session._id, { inbox_dismissed_at: null });
    }
    set({ sessions: [session, ...sessions], currentIndex: 0, injectedIds: next, dismissedIds: newDismissed, viewingDismissedId: null });
  },

  pinSession: (id) => {
    const { injectedIds } = get();
    if (injectedIds.has(id)) return;
    const next = new Set(injectedIds);
    next.add(id);
    set({ injectedIds: next });
  },

  updateSessionProject: (id, projectPath) => {
    const { sessions, injectedIds } = get();
    const updated = sessions.map((s) =>
      s._id === id ? { ...s, project_path: projectPath, git_root: projectPath } : s
    );
    const next = new Set(injectedIds);
    next.add(id);
    set({ sessions: updated, injectedIds: next });
  },

  navigateToSession: (id) => {
    const { sessions, dismissedIds } = get();
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(id)) {
      get().patch("conversations", id, { inbox_dismissed_at: null });
      set({ dismissedIds: newDismissed });
    }
    const idx = sessions.findIndex((s) => s._id === id);
    if (idx >= 0) {
      set({ currentIndex: idx, viewingDismissedId: null });
    } else {
      set({ pendingNavigateId: id, viewingDismissedId: null });
    }
  },

  replaceSessionId: (tempId, realId) => {
    const { sessions, currentIndex, injectedIds } = get();
    const tempIdx = sessions.findIndex((s) => s._id === tempId);
    if (tempIdx < 0) return;
    const newInjected = new Set(injectedIds);
    newInjected.delete(tempId);
    newInjected.add(realId);
    const realIdx = sessions.findIndex((s) => s._id === realId);
    if (realIdx >= 0) {
      const updated = sessions.filter((s) => s._id !== tempId);
      const realInUpdated = updated.findIndex((s) => s._id === realId);
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

  setMessages: (convId, msgs, meta) => {
    set((s) => ({
      messages: { ...s.messages, [convId]: msgs },
      pagination: {
        ...s.pagination,
        [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...meta },
      },
    }));
  },

  mergeMessages: (convId, msgs, direction, meta) => {
    set((s) => {
      const existing = s.messages[convId] || [];
      const existingIds = new Set(existing.map((m) => m._id));
      const unique = msgs.filter((m) => !existingIds.has(m._id));
      if (unique.length === 0 && !meta) return s;

      const merged = direction === "prepend"
        ? [...unique, ...existing]
        : [...existing, ...unique];
      merged.sort((a, b) => a.timestamp - b.timestamp);

      return {
        messages: { ...s.messages, [convId]: merged },
        pagination: meta
          ? { ...s.pagination, [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...meta } }
          : s.pagination,
      };
    });
  },

  addOptimisticMessage: (convId, content, images) => {
    const id = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const msg: OptimisticMessage = {
      _id: id,
      role: "user",
      content,
      timestamp: Date.now(),
      _isOptimistic: true,
      ...(images && images.length > 0 ? { images } : {}),
    };
    set((s) => ({
      optimisticMessages: {
        ...s.optimisticMessages,
        [convId]: [...(s.optimisticMessages[convId] || []), msg],
      },
    }));
    return id;
  },

  removeOptimisticMessage: (convId, messageId) => {
    set((s) => {
      const current = s.optimisticMessages[convId];
      if (!current) return s;
      return {
        optimisticMessages: {
          ...s.optimisticMessages,
          [convId]: current.filter((m) => m._id !== messageId),
        },
      };
    });
  },

  removeMatchingOptimistic: (convId, content) => {
    set((s) => {
      const current = s.optimisticMessages[convId];
      if (!current) return s;
      const normalize = (str: string) => str.replace(/\[image\]/gi, "").trim();
      const trimmed = normalize(content);
      let removed = false;
      const filtered = current.filter((m) => {
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

  setPagination: (convId, update) => {
    set((s) => ({
      pagination: {
        ...s.pagination,
        [convId]: { ...(s.pagination[convId] || DEFAULT_PAGINATION), ...update },
      },
    }));
  },

  initPagination: (convId) => {
    const existing = get().pagination[convId];
    if (existing) return;
    set((s) => ({
      pagination: { ...s.pagination, [convId]: { ...DEFAULT_PAGINATION } },
    }));
  },

  // =====================
  // METADATA
  // =====================

  setConversationMeta: (convId, meta) => {
    set((s) => ({
      conversations: { ...s.conversations, [convId]: meta },
    }));
  },

  updateConversationMeta: (convId, partial) => {
    set((s) => {
      const prev = s.conversations[convId];
      if (!prev) return s;
      return {
        conversations: { ...s.conversations, [convId]: { ...prev, ...partial } },
      };
    });
  },

  setCurrentConversation: (ctx) => {
    set({ currentConversation: ctx });
  },

  clearCurrentConversation: () => {
    set({ currentConversation: {} });
  },

  // =====================
  // PATCHES (optimistic mutations)
  // =====================

  patch: (table, id, fields) => {
    const prev = get().pendingPatches[id] || {};
    set((s) => ({
      pendingPatches: {
        ...s.pendingPatches,
        [id]: { ...prev, ...fields },
      },
    }));

    const mutationFn = get().mutations[table];
    if (mutationFn) {
      mutationFn(id, fields).catch(() => {
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
          set((s) => {
            const next = { ...s.pendingPatches };
            delete next[id];
            return { pendingPatches: next };
          });
        } else {
          set((s) => ({
            pendingPatches: { ...s.pendingPatches, [id]: rolled },
          }));
        }
      });
    }
  },

  confirmPatch: (id) => {
    set((s) => {
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

  registerMutation: (table, fn) => {
    set((s) => ({
      mutations: { ...s.mutations, [table]: fn },
    }));
  },

  // =====================
  // DRAFTS
  // =====================

  setDraft: (id, fields) => {
    set((s) => ({
      drafts: { ...s.drafts, [id]: fields },
    }));
  },

  getDraft: (id) => {
    return get().drafts[id];
  },

  clearDraft: (id) => {
    set((s) => {
      const next = { ...s.drafts };
      delete next[id];
      return { drafts: next };
    });
  },

  // =====================
  // TEMP ID
  // =====================

  resolveTempId: (tempId, realId) => {
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

  getRealId: (id) => {
    return get().tempIdMap[id] || id;
  },

  // =====================
  // SELECTORS
  // =====================

  getSession: (id) => {
    const { sessions, dismissedSessions } = get();
    const s = sessions.find((s) => s._id === id) || dismissedSessions.find((s) => s._id === id);
    return s ? get().applyPatch(s as any) as InboxSession : undefined;
  },

  getMergedMessages: (convId) => {
    const { messages, optimisticMessages } = get();
    const cached = messages[convId] || [];
    const optimistic = optimisticMessages[convId] || [];
    if (optimistic.length === 0) return cached;
    const existingContents = new Set(
      cached
        .filter((m) => m.role === "user" && m.content)
        .map((m) => stripImageRef(m.content!))
    );
    const fresh = optimistic.filter(
      (m) => !existingContents.has(stripImageRef(m.content))
    );
    if (fresh.length === 0) return cached;
    return [...cached, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
  },
}));
