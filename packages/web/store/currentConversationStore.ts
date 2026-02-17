import { create } from "zustand";

interface CurrentConversationContext {
  conversationId?: string;
  projectPath?: string;
  gitRoot?: string;
  agentType?: string;
  source?: "inbox" | "sessions";
}

interface CurrentConversationStore {
  context: CurrentConversationContext;
  set: (ctx: CurrentConversationContext) => void;
  clear: () => void;
}

export const useCurrentConversationStore = create<CurrentConversationStore>((set) => ({
  context: {},
  set: (ctx) => set({ context: ctx }),
  clear: () => set({ context: {} }),
}));
