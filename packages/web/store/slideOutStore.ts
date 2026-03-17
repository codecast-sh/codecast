import { create } from "zustand";

type SlideOutType = "plan" | "task" | null;

interface SlideOutState {
  type: SlideOutType;
  id: string | null;
  open: (type: "plan" | "task", id: string) => void;
  close: () => void;
}

export const useSlideOutStore = create<SlideOutState>((set) => ({
  type: null,
  id: null,
  open: (type, id) => set({ type, id }),
  close: () => set({ type: null, id: null }),
}));
