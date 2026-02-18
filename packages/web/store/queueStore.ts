import { create } from "zustand";
import { patch as cachePatch, confirm as cacheConfirm } from "./convexCache";

export type InboxSession = {
  _id: string;
  session_id: string;
  title?: string;
  subtitle?: string;
  updated_at: number;
  project_path?: string;
  git_root?: string;
  git_branch?: string;
  agent_type: string;
  message_count: number;
  idle_summary?: string;
  is_idle: boolean;
  has_pending: boolean;
  is_deferred?: boolean;
  last_user_message?: string | null;
};

interface InboxState {
  sessions: InboxSession[];
  dismissedSessions: InboxSession[];
  currentIndex: number;
  dismissedIds: Set<string>;
  injectedIds: Set<string>;
  showDismissed: boolean;
  viewingDismissedId: string | null;

  syncFromConvex: (sessions: InboxSession[]) => void;
  syncDismissedFromConvex: (sessions: InboxSession[]) => void;
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
  replaceSessionId: (tempId: string, realId: string) => void;
}

export const useQueueStore = create<InboxState>((set, get) => ({
  sessions: [],
  dismissedSessions: [],
  currentIndex: 0,
  dismissedIds: new Set(),
  injectedIds: new Set(),
  showDismissed: false,
  viewingDismissedId: null,

  syncFromConvex: (incoming) => {
    const { dismissedIds, currentIndex, sessions: prev } = get();
    const incomingById = new Map(incoming.map((s) => [s._id, s]));

    for (const s of incoming) {
      cacheConfirm(s._id);
    }

    const visibleIncoming = incoming.filter((s) => !dismissedIds.has(s._id));

    if (prev.length === 0) {
      const clampedIndex = Math.min(currentIndex, Math.max(0, visibleIncoming.length - 1));
      set({ sessions: visibleIncoming, currentIndex: clampedIndex });
      return;
    }

    const merged: InboxSession[] = [];
    const seen = new Set<string>();

    const { injectedIds } = get();
    for (const old of prev) {
      if (old._id.startsWith("temp_")) {
        merged.push(old);
        seen.add(old._id);
        continue;
      }
      if (injectedIds.has(old._id) && !dismissedIds.has(old._id)) {
        const fresh = incomingById.get(old._id);
        merged.push(fresh || old);
        seen.add(old._id);
        continue;
      }
      const fresh = incomingById.get(old._id);
      if (fresh && !dismissedIds.has(old._id)) {
        merged.push(fresh);
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

    cachePatch("conversations", id, { inbox_dismissed_at: Date.now() });
  },

  unstashSession: (id) => {
    const { dismissedIds } = get();
    const newDismissed = new Set(dismissedIds);
    newDismissed.delete(id);
    set({ dismissedIds: newDismissed });

    cachePatch("conversations", id, { inbox_dismissed_at: null });
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

    cachePatch("conversations", id, { inbox_deferred_at: Date.now() });
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

  setViewingDismissedId: (id) => {
    set({ viewingDismissedId: id });
  },

  setShowDismissed: (show) => {
    set({ showDismissed: show });
  },

  getCurrentSession: () => {
    const { sessions, currentIndex } = get();
    return sessions[currentIndex] ?? null;
  },

  injectSession: (session) => {
    const { sessions, injectedIds } = get();
    const next = new Set(injectedIds);
    next.add(session._id);
    set({ sessions: [session, ...sessions], currentIndex: 0, injectedIds: next });
  },

  replaceSessionId: (tempId, realId) => {
    const { sessions, currentIndex } = get();
    const tempIdx = sessions.findIndex((s) => s._id === tempId);
    if (tempIdx < 0) return;
    const realIdx = sessions.findIndex((s) => s._id === realId);
    if (realIdx >= 0) {
      const updated = sessions.filter((s) => s._id !== tempId);
      const newIndex = currentIndex === tempIdx ? realIdx > tempIdx ? realIdx - 1 : realIdx : Math.min(currentIndex, updated.length - 1);
      set({ sessions: updated, currentIndex: newIndex });
    } else {
      const updated = [...sessions];
      updated[tempIdx] = { ...updated[tempIdx], _id: realId };
      set({ sessions: updated });
    }
  },
}));
