import { create } from "zustand";

interface NewSessionStore {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useNewSessionStore = create<NewSessionStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
