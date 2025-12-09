import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Conversation {
  _id: string;
  title?: string;
  project_hash?: string;
  is_active: boolean;
  updated_at: number;
  [key: string]: unknown;
}

type ConversationGroup =
  | { type: 'active-group'; title: string; conversations: Conversation[] }
  | { type: 'project-group'; title: string; projectHash: string; displayPath: string; conversations: Conversation[] };

function deriveDisplayPath(projectHash: string | undefined, conversations: Conversation[]): string {
  if (!projectHash) return 'No Project';

  // Try to infer project name from conversation titles or slugs
  const firstConv = conversations[0];
  if (firstConv?.title) {
    const match = firstConv.title.match(/\[(.*?)\]/);
    if (match) return match[1];
  }

  // Fallback: show truncated hash
  return `proj-${projectHash.slice(0, 6)}`;
}

function buildConversationGroups(conversations: Conversation[]): ConversationGroup[] {
  const result: ConversationGroup[] = [];

  // 1. Active conversations at top
  const active = conversations.filter(c => c.is_active);
  if (active.length > 0) {
    result.push({
      type: 'active-group',
      title: 'Active',
      conversations: active.sort((a, b) => b.updated_at - a.updated_at),
    });
  }

  // 2. Group inactive by project
  const inactive = conversations.filter(c => !c.is_active);
  const byProject = new Map<string, Conversation[]>();

  for (const conv of inactive) {
    const key = conv.project_hash || '__no_project__';
    const existing = byProject.get(key) || [];
    existing.push(conv);
    byProject.set(key, existing);
  }

  // 3. Create project groups, sorted by most recent conversation in each project
  const projectGroups: ConversationGroup[] = [];
  for (const [hash, convs] of byProject) {
    convs.sort((a, b) => b.updated_at - a.updated_at);
    const mostRecent = convs[0].updated_at;

    projectGroups.push({
      type: 'project-group',
      title: deriveDisplayPath(hash === '__no_project__' ? undefined : hash, convs),
      projectHash: hash,
      displayPath: deriveDisplayPath(hash === '__no_project__' ? undefined : hash, convs),
      conversations: convs,
    });
  }

  // Sort project groups by most recent conversation
  projectGroups.sort((a, b) => {
    const aRecent = Math.max(...a.conversations.map(c => c.updated_at));
    const bRecent = Math.max(...b.conversations.map(c => c.updated_at));
    return bRecent - aRecent;
  });

  result.push(...projectGroups);

  return result;
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
