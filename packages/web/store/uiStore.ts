import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Placeholder types - to be replaced with actual Convex types
interface Conversation {
  id: string;
  [key: string]: unknown;
}

interface ConversationGroup {
  title: string;
  conversations: Conversation[];
}

// Helper to build conversation groups (placeholder implementation)
function buildConversationGroups(conversations: Conversation[]): ConversationGroup[] {
  // Simple grouping by date or other criteria
  // This is a placeholder - actual implementation would group by date, project, etc.
  return [
    {
      title: 'All Conversations',
      conversations,
    },
  ];
}

interface UIState {
  // Persisted state
  expandedToolCalls: Set<string>;
  collapsedSections: Set<string>;
  theme: 'light' | 'dark';

  // Session state
  searchQuery: string;
  activeFilter: 'my' | 'team';

  // Derived from Convex data (computed on apply)
  groupedConversations: ConversationGroup[] | null;

  // Actions
  toggleToolCall: (id: string) => void;
  toggleSection: (id: string) => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setSearchQuery: (query: string) => void;
  setFilter: (filter: 'my' | 'team') => void;
  applyConversations: (convs: Conversation[]) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      expandedToolCalls: new Set(),
      collapsedSections: new Set(),
      theme: 'dark',
      searchQuery: '',
      activeFilter: 'my',
      groupedConversations: null,

      toggleToolCall: (id) =>
        set((state) => {
          const next = new Set(state.expandedToolCalls);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return { expandedToolCalls: next };
        }),

      toggleSection: (id) =>
        set((state) => {
          const next = new Set(state.collapsedSections);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return { collapsedSections: next };
        }),

      setTheme: (theme) => set({ theme }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setFilter: (filter) => set({ activeFilter: filter }),

      applyConversations: (convs) =>
        set({
          groupedConversations: buildConversationGroups(convs),
        }),
    }),
    {
      name: 'codecast-ui',
      partialize: (state) => ({
        expandedToolCalls: Array.from(state.expandedToolCalls),
        collapsedSections: Array.from(state.collapsedSections),
        theme: state.theme,
      }),
      // Hydration: convert arrays back to Sets
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<{
          expandedToolCalls: string[];
          collapsedSections: string[];
          theme: 'light' | 'dark';
        }>;

        return {
          ...currentState,
          expandedToolCalls: new Set(persisted.expandedToolCalls || []),
          collapsedSections: new Set(persisted.collapsedSections || []),
          theme: persisted.theme || currentState.theme,
        };
      },
    }
  )
);
