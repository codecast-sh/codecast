import { create } from "zustand";

type SlideOutType = "plan" | "task" | null;

interface SlideOutState {
  type: SlideOutType;
  id: string | null;
  pendingNav: { type: "plan" | "task"; id: string } | null;
  open: (type: "plan" | "task", id: string) => void;
  close: () => void;
  clearNav: () => void;
}

export const useSlideOutStore = create<SlideOutState>((set) => ({
  type: null,
  id: null,
  pendingNav: null,
  open: (type, id) => set({ pendingNav: { type, id } }),
  close: () => set({ type: null, id: null, pendingNav: null }),
  clearNav: () => set({ pendingNav: null }),
}));
