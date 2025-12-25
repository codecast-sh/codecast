import { create } from 'zustand';
import { computeCumulativeDiff } from '../lib/cumulativeDiff';

export interface FileChange {
  id: string;
  sequenceIndex: number;
  messageId: string;
  filePath: string;
  changeType: 'write' | 'edit';
  oldContent?: string;
  newContent: string;
  timestamp: number;
}

interface DiffViewerState {
  selectedChangeIndex: number | null;
  rangeStart: number | null;
  rangeEnd: number | null;
  diffMode: 'cumulative' | 'single';
  syncScroll: boolean;
  showFileTree: boolean;
  changes: FileChange[];
  selectedFile: string | null;

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

  setChanges: (changes) => set({ changes }),

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
    const { changes } = get();
    const uniqueFiles = new Set(changes.map((c) => c.filePath));
    return Array.from(uniqueFiles).sort();
  },

  getCurrentDiffContent: () => {
    const { selectedChangeIndex, rangeStart, rangeEnd, changes, diffMode, selectedFile } = get();

    if (selectedChangeIndex === null || changes.length === 0) {
      return null;
    }

    const change = changes[selectedChangeIndex];
    if (!change) return null;

    if (rangeStart !== null && rangeEnd !== null) {
      const relevantChanges = changes.slice(rangeStart, rangeEnd + 1);
      const cumulativeDiffs = computeCumulativeDiff(relevantChanges);

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
    }

    if (diffMode === 'single') {
      return {
        filePath: change.filePath,
        oldContent: change.oldContent,
        newContent: change.newContent,
      };
    }

    const relevantChanges = changes.slice(0, selectedChangeIndex + 1);
    const cumulativeDiffs = computeCumulativeDiff(relevantChanges);

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
