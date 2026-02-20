import { create } from 'zustand';

type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
  images?: Array<{ media_type: string; data?: string; storage_id?: string }>;
  subtype?: string;
};

interface ForkNavigationState {
  selectedIndex: number | null;
  activeBranches: Record<string, string>;
  loadedForkMessages: Record<string, Message[]>;
  treePanelOpen: boolean;

  setSelectedIndex: (index: number | null) => void;
  switchBranch: (messageUuid: string, convId: string) => void;
  clearBranch: (messageUuid: string) => void;
  setForkMessages: (convId: string, messages: Message[]) => void;
  toggleTreePanel: () => void;
  reset: () => void;
}

export const useForkNavigationStore = create<ForkNavigationState>()((set) => ({
  selectedIndex: null,
  activeBranches: {},
  loadedForkMessages: {},
  treePanelOpen: false,

  setSelectedIndex: (index) => set({ selectedIndex: index }),

  switchBranch: (messageUuid, convId) =>
    set((state) => ({
      activeBranches: { ...state.activeBranches, [messageUuid]: convId },
    })),

  clearBranch: (messageUuid) =>
    set((state) => {
      const next = { ...state.activeBranches };
      delete next[messageUuid];
      return { activeBranches: next };
    }),

  setForkMessages: (convId, messages) =>
    set((state) => ({
      loadedForkMessages: { ...state.loadedForkMessages, [convId]: messages },
    })),

  toggleTreePanel: () => set((state) => ({ treePanelOpen: !state.treePanelOpen })),

  reset: () =>
    set({
      selectedIndex: null,
      activeBranches: {},
      loadedForkMessages: {},
      treePanelOpen: false,
    }),
}));
