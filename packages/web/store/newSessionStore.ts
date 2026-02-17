import { create } from "zustand";

export interface SessionContext {
  projectPath?: string;
  gitRoot?: string;
  agentType?: string;
  source?: "inbox" | "sessions";
}

interface NewSessionStore {
  isOpen: boolean;
  context: SessionContext;
  open: (ctx?: SessionContext) => void;
  close: () => void;
}

export const useNewSessionStore = create<NewSessionStore>((set) => ({
  isOpen: false,
  context: {},
  open: (ctx) => set({ isOpen: true, context: ctx || {} }),
  close: () => set({ isOpen: false, context: {} }),
}));
