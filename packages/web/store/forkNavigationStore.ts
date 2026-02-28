import { create } from 'zustand';

interface ForkNavigationState {
  selectedIndex: number | null;
  treePanelOpen: boolean;

  setSelectedIndex: (index: number | null) => void;
  toggleTreePanel: () => void;
  reset: () => void;
}

export const useForkNavigationStore = create<ForkNavigationState>()((set) => ({
  selectedIndex: null,
  treePanelOpen: false,

  setSelectedIndex: (index) => set({ selectedIndex: index }),
  toggleTreePanel: () => set((state) => ({ treePanelOpen: !state.treePanelOpen })),
  reset: () => set({ selectedIndex: null, treePanelOpen: false }),
}));
