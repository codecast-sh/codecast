import { create } from "zustand";

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
};

interface InboxState {
  sessions: InboxSession[];
  currentIndex: number;
  stashedIds: Set<string>;

  syncFromConvex: (sessions: InboxSession[]) => void;
  advanceToNext: () => void;
  stashSession: (id: string) => void;
  unstashSession: (id: string) => void;
  navigateUp: () => void;
  navigateDown: () => void;
  setCurrentIndex: (index: number) => void;
  getCurrentSession: () => InboxSession | null;
}

export const useQueueStore = create<InboxState>((set, get) => ({
  sessions: [],
  currentIndex: 0,
  stashedIds: new Set(),

  syncFromConvex: (incoming) => {
    const { stashedIds, currentIndex, sessions: prev } = get();
    const visible = incoming.filter((s) => !stashedIds.has(s._id));

    const currentSession = prev[currentIndex];
    if (currentSession) {
      const newIdx = visible.findIndex((s) => s._id === currentSession._id);
      if (newIdx >= 0) {
        set({ sessions: visible, currentIndex: newIdx });
      } else {
        const preserved = [...visible];
        const insertAt = Math.min(currentIndex, preserved.length);
        preserved.splice(insertAt, 0, currentSession);
        set({ sessions: preserved, currentIndex: insertAt });
      }
    } else {
      const clampedIndex = Math.min(currentIndex, Math.max(0, visible.length - 1));
      set({ sessions: visible, currentIndex: clampedIndex });
    }
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
    const { sessions, currentIndex, stashedIds } = get();
    const newStashed = new Set(stashedIds);
    newStashed.add(id);

    const visible = sessions.filter((s) => !newStashed.has(s._id));
    const newIndex = Math.min(currentIndex, Math.max(0, visible.length - 1));
    set({ stashedIds: newStashed, sessions: visible, currentIndex: newIndex });
  },

  unstashSession: (id) => {
    const { stashedIds } = get();
    const newStashed = new Set(stashedIds);
    newStashed.delete(id);
    set({ stashedIds: newStashed });
  },

  navigateUp: () => {
    const { currentIndex } = get();
    if (currentIndex > 0) {
      set({ currentIndex: currentIndex - 1 });
    }
  },

  navigateDown: () => {
    const { sessions, currentIndex } = get();
    if (currentIndex < sessions.length - 1) {
      set({ currentIndex: currentIndex + 1 });
    }
  },

  setCurrentIndex: (index) => {
    const { sessions } = get();
    if (index >= 0 && index < sessions.length) {
      set({ currentIndex: index });
    }
  },

  getCurrentSession: () => {
    const { sessions, currentIndex } = get();
    return sessions[currentIndex] ?? null;
  },
}));
