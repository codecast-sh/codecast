import { create } from "zustand";
import { patch as cachePatch, confirm as cacheConfirm, apply as cacheApply, useConvexCacheStore } from "./convexCache";

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

interface InboxState {
  sessions: InboxSession[];
  dismissedSessions: InboxSession[];
  currentIndex: number;
  dismissedIds: Set<string>;
  injectedIds: Set<string>;
  showDismissed: boolean;
  viewingDismissedId: string | null;
  pendingNavigateId: string | null;

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
  pinSession: (id: string) => void;
  updateSessionProject: (id: string, projectPath: string) => void;
  replaceSessionId: (tempId: string, realId: string) => void;
  navigateToSession: (id: string) => void;
}

export const useQueueStore = create<InboxState>((set, get) => ({
  sessions: [],
  dismissedSessions: [],
  currentIndex: 0,
  dismissedIds: new Set(),
  injectedIds: new Set(),
  showDismissed: false,
  viewingDismissedId: null,
  pendingNavigateId: null,

  syncFromConvex: (incoming) => {
    const { dismissedIds, currentIndex, sessions: prev } = get();
    const incomingById = new Map(incoming.map((s) => [s._id, s]));

    for (const s of incoming) {
      const pending = useConvexCacheStore.getState()._pending[s._id];
      if (!pending || Object.entries(pending).every(([k, v]) => (s as any)[k] === v)) {
        cacheConfirm(s._id);
      }
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
        let resolved = fresh || old;
        resolved = cacheApply(resolved as any) as InboxSession;
        merged.push(old.stableKey ? { ...resolved, stableKey: old.stableKey } : resolved);
        seen.add(old._id);
        continue;
      }
      const fresh = incomingById.get(old._id);
      if (fresh && !dismissedIds.has(old._id)) {
        const applied = cacheApply(fresh as any) as InboxSession;
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
    const { sessions, injectedIds, dismissedIds } = get();
    const next = new Set(injectedIds);
    next.add(session._id);
    const newDismissed = new Set(dismissedIds);
    if (newDismissed.delete(session._id)) {
      cachePatch("conversations", session._id, { inbox_dismissed_at: null });
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
      cachePatch("conversations", id, { inbox_dismissed_at: null });
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
      const newIndex = currentIndex === tempIdx ? realIdx > tempIdx ? realIdx - 1 : realIdx : Math.min(currentIndex, updated.length - 1);
      set({ sessions: updated, currentIndex: newIndex, injectedIds: newInjected });
    } else {
      const updated = [...sessions];
      updated[tempIdx] = { ...updated[tempIdx], _id: realId, stableKey: tempId };
      set({ sessions: updated, injectedIds: newInjected });
    }
  },
}));
