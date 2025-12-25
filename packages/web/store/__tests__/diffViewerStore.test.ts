import { describe, it, expect, beforeEach } from 'bun:test';
import { useDiffViewerStore } from '../diffViewerStore';
import type { FileChange } from '../diffViewerStore';

describe('diffViewerStore', () => {
  beforeEach(() => {
    useDiffViewerStore.setState({
      selectedChangeIndex: null,
      rangeStart: null,
      rangeEnd: null,
      diffMode: 'cumulative',
      syncScroll: true,
      showFileTree: true,
      changes: [],
      selectedFile: null,
    });
  });

  describe('getCurrentDiffContent', () => {
    it('returns null when no changes', () => {
      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toBeNull();
    });

    it('returns null when selectedChangeIndex is null', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
      ];

      useDiffViewerStore.setState({ changes });
      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toBeNull();
    });

    it('returns single change in single mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 1000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 0,
        diffMode: 'single',
      });

      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toEqual({
        filePath: 'test.ts',
        oldContent: 'const x = 1;',
        newContent: 'const x = 2;',
      });
    });

    it('returns cumulative diff in cumulative mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 2000,
        },
        {
          id: '3',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 2;',
          newContent: 'const x = 3;',
          timestamp: 3000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 2,
        diffMode: 'cumulative',
      });

      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toEqual({
        filePath: 'test.ts',
        oldContent: undefined,
        newContent: 'const x = 3;',
      });
    });

    it('handles multiple files in cumulative mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'a.ts',
          changeType: 'write',
          newContent: 'const a = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'b.ts',
          changeType: 'write',
          newContent: 'const b = 2;',
          timestamp: 2000,
        },
        {
          id: '3',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'a.ts',
          changeType: 'edit',
          oldContent: 'const a = 1;',
          newContent: 'const a = 10;',
          timestamp: 3000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 2,
        diffMode: 'cumulative',
      });

      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toEqual({
        filePath: 'a.ts',
        oldContent: undefined,
        newContent: 'const a = 10;',
      });
    });

    it('respects selectedFile in cumulative mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'a.ts',
          changeType: 'write',
          newContent: 'const a = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'b.ts',
          changeType: 'write',
          newContent: 'const b = 2;',
          timestamp: 2000,
        },
        {
          id: '3',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'a.ts',
          changeType: 'edit',
          oldContent: 'const a = 1;',
          newContent: 'const a = 10;',
          timestamp: 3000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 2,
        diffMode: 'cumulative',
        selectedFile: 'b.ts',
      });

      const content = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(content).toEqual({
        filePath: 'b.ts',
        oldContent: undefined,
        newContent: 'const b = 2;',
      });
    });
  });

  describe('getSelectedChanges', () => {
    it('returns all changes when nothing selected', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
      ];

      useDiffViewerStore.setState({ changes });
      const selected = useDiffViewerStore.getState().getSelectedChanges();
      expect(selected).toEqual(changes);
    });

    it('returns changes up to selected index in cumulative mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 2000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 0,
        diffMode: 'cumulative',
      });

      const selected = useDiffViewerStore.getState().getSelectedChanges();
      expect(selected).toEqual([changes[0]]);
    });

    it('returns single change in single mode', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 2000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        selectedChangeIndex: 1,
        diffMode: 'single',
      });

      const selected = useDiffViewerStore.getState().getSelectedChanges();
      expect(selected).toEqual([changes[1]]);
    });

    it('returns range when range is selected', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'const x = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 2000,
        },
        {
          id: '3',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 2;',
          newContent: 'const x = 3;',
          timestamp: 3000,
        },
      ];

      useDiffViewerStore.setState({
        changes,
        rangeStart: 0,
        rangeEnd: 1,
        selectedChangeIndex: 1,
        diffMode: 'cumulative',
      });

      const selected = useDiffViewerStore.getState().getSelectedChanges();
      expect(selected).toEqual([changes[0], changes[1]]);
    });
  });
});
