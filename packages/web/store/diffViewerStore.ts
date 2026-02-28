import { create } from 'zustand';
import { computeCumulativeDiff, type CumulativeDiff } from '../lib/cumulativeDiff';
import { LRUCache } from '../lib/lruCache';
import { useInboxStore } from './inboxStore';

export interface FileChange {
  id: string;
  toolCallId?: string;
  sequenceIndex: number;
  messageId: string;
  filePath: string;
  changeType: 'write' | 'edit' | 'commit';
  oldContent?: string;
  newContent: string;
  commitMessage?: string;
  commitHash?: string;
  timestamp: number;
}

interface DiffCacheKey {
  rangeStart: number;
  rangeEnd: number;
  diffMode: 'cumulative' | 'single';
  changesHash: string;
}

const diffCache = new LRUCache<DiffCacheKey, CumulativeDiff[]>(50);

function hashChanges(changes: FileChange[]): string {
  if (changes.length === 0) return 'empty';
  return `${changes.length}-${changes[0]?.id}-${changes[changes.length - 1]?.id}`;
}

export function clearDiffCache() {
  diffCache.clear();
}

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
  changes: FileChange[];
  selectedFile: string | null;
  diffPanelOpen: boolean;

  selectChange: (index: number) => void;
  selectRange: (start: number, end: number) => void;
  clearSelection: () => void;
  toggleDiffMode: () => void;
  toggleSyncScroll: () => void;
  toggleFileTree: () => void;
  setChanges: (changes: FileChange[]) => void;
  selectFile: (filePath: string | null) => void;
  nextChange: () => void;
  prevChange: () => void;
  toggleDiffPanel: () => void;
  setDiffPanelOpen: (open: boolean) => void;

  getSelectedChanges: () => FileChange[];
  getFilesList: () => string[];
  getCurrentDiffContent: () => { filePath: string; oldContent?: string; newContent: string } | null;
}

export const useDiffViewerStore = create<DiffViewerState>((set, get) => ({
  selectedChangeIndex: null,
  rangeStart: null,
  rangeEnd: null,
  diffMode: 'cumulative',
  syncScroll: true,
  showFileTree: true,
  changes: [],
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

  setChanges: (changes) => {
    diffCache.clear();
    set({ changes });
  },

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

  getCurrentDiffContent: () => {
    const { selectedChangeIndex, rangeStart, rangeEnd, changes, diffMode, selectedFile } = get();

    if (selectedChangeIndex === null || changes.length === 0) {
      return null;
    }

    const change = changes[selectedChangeIndex];
    if (!change) return null;

    if (diffMode === 'single') {
      return {
        filePath: change.filePath,
        oldContent: change.oldContent,
        newContent: change.newContent,
      };
    }

    const actualRangeStart = rangeStart ?? 0;
    const actualRangeEnd = rangeEnd ?? selectedChangeIndex;

    const cacheKey: DiffCacheKey = {
      rangeStart: actualRangeStart,
      rangeEnd: actualRangeEnd,
      diffMode,
      changesHash: hashChanges(changes),
    };

    let cumulativeDiffs = diffCache.get(cacheKey);

    if (!cumulativeDiffs) {
      const relevantChanges = changes.slice(actualRangeStart, actualRangeEnd + 1);
      cumulativeDiffs = computeCumulativeDiff(relevantChanges);
      diffCache.set(cacheKey, cumulativeDiffs);
    }

    const targetFile = selectedFile || change.filePath;
    const cumulativeDiff = cumulativeDiffs.find(d => d.filePath === targetFile);

    if (!cumulativeDiff) {
      return {
        filePath: change.filePath,
        oldContent: change.oldContent,
        newContent: change.newContent,
      };
    }

    return {
      filePath: cumulativeDiff.filePath,
      oldContent: cumulativeDiff.oldContent,
      newContent: cumulativeDiff.newContent,
    };
  },
}));
