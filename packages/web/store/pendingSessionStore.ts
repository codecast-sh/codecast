import { create } from "zustand";

interface PendingSessionStore {
  resolved: Record<string, string>;
  resolve: (tempId: string, realId: string) => void;
  getRealId: (id: string) => string;
}

export const usePendingSessionStore = create<PendingSessionStore>((set, get) => ({
  resolved: {},
  resolve: (tempId, realId) =>
    set((s) => ({ resolved: { ...s.resolved, [tempId]: realId } })),
  getRealId: (id) => get().resolved[id] || id,
}));
