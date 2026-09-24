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
      conversationId: null,
      bodies: {},
      missingBodies: {},
      selectedFile: null,
    });
  });

  describe('bodies', () => {
    it('seeds the body cache from changes that carry their text and forgets it on a new conversation', () => {
      const store = useDiffViewerStore.getState();
      store.setChanges('conv-a', [
        { id: 'a', sequenceIndex: 0, messageId: 'm', filePath: 'a.ts', changeType: 'edit', oldContent: 'x', newContent: 'y', timestamp: 1 },
        { id: 'b', sequenceIndex: 1, messageId: 'm', filePath: 'b.ts', changeType: 'write', newBytes: 3, timestamp: 2 },
      ]);
      expect(useDiffViewerStore.getState().bodies).toEqual({ a: { oldContent: 'x', newContent: 'y' } });
      store.addBodies('conv-a', [{ id: 'b', newContent: 'abc' }], ['c']);
      expect(useDiffViewerStore.getState().bodies.b).toEqual({ newContent: 'abc' });
      expect(useDiffViewerStore.getState().missingBodies).toEqual({ c: true });
      // An answer for another conversation is dropped.
      store.addBodies('conv-b', [{ id: 'z', newContent: 'zzz' }]);
      expect(useDiffViewerStore.getState().bodies.z).toBeUndefined();
      store.setChanges('conv-b', []);
      expect(useDiffViewerStore.getState().bodies).toEqual({});
      expect(useDiffViewerStore.getState().missingBodies).toEqual({});
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
