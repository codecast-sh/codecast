import { create } from 'zustand';
import { useInboxStore } from './inboxStore';

// FileChange and its text-free twin FileChangeRef are defined once in the
// shared extractor (@codecast/convex) so the server materializer and the
// client viewer can't drift. Re-exported here to preserve the many
// `import type { FileChange } from '../store/diffViewerStore'` sites.
import type { FileChange, FileChangeBody, FileChangeRef } from '../lib/fileChangeExtractor';
export type { FileChange, FileChangeBody, FileChangeRef };

/** What the timeline holds: the server's references (sizes, no text) merged
 *  with the loaded window's own extraction (text known). A fold reads the
 *  text from `bodies`, keyed by change id, filled by useFileChangeBodies. */
export type FileChangeEntry = Omit<FileChangeRef, "oldBytes" | "newBytes"> &
  Partial<Pick<FileChangeRef, "oldBytes" | "newBytes">> &
  Partial<FileChangeBody>;

const getInitialDiffPanelOpen = () => {
  return useInboxStore.getState().clientState.ui?.diff_panel_open ?? false;
};

interface DiffViewerState {
  selectedChangeIndex: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  diffMode: 'cumulative' | 'single';
  syncScroll: boolean;
  showFileTree: boolean;
  changes: FileChangeEntry[];
  /** The conversation `changes` and `bodies` describe. */
  conversationId: string | null;
  /** Text of the changes fetched so far, by change id. Lives only as long as
   *  the conversation is open: a whale session's bodies never persist. */
  bodies: Record<string, FileChangeBody>;
  /** Changes the server has no text for (asked and not answered): their
   *  files cannot fold and are not waited on. */
  missingBodies: Record<string, true>;
  selectedFile: string | null;
  diffPanelOpen: boolean;

  selectChange: (index: number) => void;
  selectRange: (start: number, end: number) => void;
  clearSelection: () => void;
  toggleDiffMode: () => void;
  toggleSyncScroll: () => void;
  toggleFileTree: () => void;
  setChanges: (conversationId: string | null, changes: FileChangeEntry[]) => void;
  addBodies: (conversationId: string, bodies: Array<FileChangeBody & { id: string }>, missing?: string[]) => void;
  selectFile: (filePath: string | null) => void;
  nextChange: () => void;
  prevChange: () => void;
  toggleDiffPanel: () => void;
  setDiffPanelOpen: (open: boolean) => void;

  getSelectedChanges: () => FileChangeEntry[];
  getFilesList: () => string[];
}

export const useDiffViewerStore = create<DiffViewerState>((set, get) => ({
  selectedChangeIndex: null,
  rangeStart: null,
  rangeEnd: null,
  diffMode: 'cumulative',
  syncScroll: true,
  showFileTree: true,
  changes: [],
  conversationId: null,
  bodies: {},
  missingBodies: {},
  selectedFile: null,
  diffPanelOpen: getInitialDiffPanelOpen(),

  selectChange: (index) =>
    set({
      selectedChangeIndex: index,
      rangeStart: null,
      rangeEnd: null,
    }),

  selectRange: (start, end) => {
    const validStart = Math.min(start, end);
    const validEnd = Math.max(start, end);
    set({
      rangeStart: validStart,
      rangeEnd: validEnd,
      selectedChangeIndex: validEnd,
    });
  },

  clearSelection: () =>
    set({
      selectedChangeIndex: null,
      rangeStart: null,
      rangeEnd: null,
    }),

  toggleDiffMode: () =>
    set((state) => ({
      diffMode: state.diffMode === 'cumulative' ? 'single' : 'cumulative',
    })),

  toggleSyncScroll: () => set((state) => ({ syncScroll: !state.syncScroll })),

  toggleFileTree: () => set((state) => ({ showFileTree: !state.showFileTree })),

  toggleDiffPanel: () => set((state) => {
    const newValue = !state.diffPanelOpen;
    useInboxStore.getState().updateClientUI({ diff_panel_open: newValue });
    return { diffPanelOpen: newValue };
  }),

  setDiffPanelOpen: (open) => {
    useInboxStore.getState().updateClientUI({ diff_panel_open: open });
    set({ diffPanelOpen: open });
  },

  setChanges: (conversationId, changes) =>
    set((state) => {
      // The window's own extraction already knows its text: seed the bodies so
      // those changes never round-trip. A new conversation starts empty.
      const bodies: Record<string, FileChangeBody> =
        conversationId === state.conversationId ? { ...state.bodies } : {};
      for (const change of changes) {
        if (change.newContent !== undefined && !bodies[change.id]) {
          bodies[change.id] = { oldContent: change.oldContent, newContent: change.newContent };
        }
      }
      return {
        conversationId,
        changes,
        bodies,
        missingBodies: conversationId === state.conversationId ? state.missingBodies : {},
      };
    }),

  addBodies: (conversationId, incoming, missing = []) =>
    set((state) => {
      // A late answer for a conversation the viewer already left.
      if (conversationId !== state.conversationId) return {};
      const bodies = { ...state.bodies };
      for (const { id, ...body } of incoming) bodies[id] = body;
      const missingBodies = { ...state.missingBodies };
      for (const id of missing) if (!bodies[id]) missingBodies[id] = true;
      return { bodies, missingBodies };
    }),

  selectFile: (filePath) => set({ selectedFile: filePath }),

  nextChange: () => {
    const { selectedChangeIndex, changes } = get();
    if (changes.length === 0) return;

    const currentIndex = selectedChangeIndex ?? -1;
    const nextIndex = currentIndex + 1;

    if (nextIndex < changes.length) {
      set({
        selectedChangeIndex: nextIndex,
        rangeStart: null,
        rangeEnd: null,
      });
    }
  },

  prevChange: () => {
    const { selectedChangeIndex, changes } = get();
    if (changes.length === 0) return;

    const currentIndex = selectedChangeIndex ?? 0;
    const prevIndex = currentIndex - 1;

    if (prevIndex >= 0) {
      set({
        selectedChangeIndex: prevIndex,
        rangeStart: null,
        rangeEnd: null,
      });
    }
  },

  getSelectedChanges: () => {
    const { changes, selectedChangeIndex, rangeStart, rangeEnd, diffMode } = get();

    if (rangeStart !== null && rangeEnd !== null) {
      return changes.slice(rangeStart, rangeEnd + 1);
    }

    if (selectedChangeIndex !== null) {
      if (diffMode === 'cumulative') {
        return changes.slice(0, selectedChangeIndex + 1);
      } else {
        return [changes[selectedChangeIndex]];
      }
    }

    return changes;
  },

  getFilesList: () => {
    const selectedChanges = get().getSelectedChanges();
    const uniqueFiles = new Set(selectedChanges.map((c) => c.filePath));
    return Array.from(uniqueFiles).sort();
  },
}));
