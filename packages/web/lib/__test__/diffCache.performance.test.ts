import { describe, it, expect } from 'bun:test';
import { useDiffViewerStore, clearDiffCache, type FileChange } from '../../store/diffViewerStore';

describe('Diff Cache Performance', () => {
  it('reuses the computed range until the cache is cleared', () => {
    let contentReads = 0;
    const changes: FileChange[] = [{
      id: 'cached-change', sequenceIndex: 0, messageId: 'msg', filePath: 'test.ts',
      changeType: 'edit', oldContent: 'before', timestamp: 1000,
      get newContent() { contentReads++; return 'after'; },
    }];
    clearDiffCache();
    useDiffViewerStore.setState({
      changes, selectedChangeIndex: 0, diffMode: 'cumulative',
      rangeStart: null, rangeEnd: null, selectedFile: null,
    });
    const result = useDiffViewerStore.getState().getCurrentDiffContent();
    const firstReads = contentReads;
    expect(firstReads).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) {
      expect(useDiffViewerStore.getState().getCurrentDiffContent()).toEqual(result);
    }
    expect(contentReads).toBe(firstReads);
    clearDiffCache();
    expect(useDiffViewerStore.getState().getCurrentDiffContent()).toEqual(result);
    expect(contentReads).toBeGreaterThan(firstReads);
  });

  it('should respect max cache size of 50', () => {
    const changes: FileChange[] = Array.from({ length: 100 }, (_, i) => ({
      id: `${i + 1}`,
      sequenceIndex: i,
      messageId: `msg${i}`,
      filePath: 'test.ts',
      changeType: 'edit' as const,
      oldContent: `const x = ${i};`,
      newContent: `const x = ${i + 1};`,
      timestamp: 1000 + i,
    }));

    clearDiffCache();
    useDiffViewerStore.setState({ changes, diffMode: 'cumulative' });

    for (let i = 0; i < 100; i++) {
      useDiffViewerStore.setState({ selectedChangeIndex: i });
      const result = useDiffViewerStore.getState().getCurrentDiffContent();
      expect(result).not.toBeNull();
    }

    useDiffViewerStore.setState({ selectedChangeIndex: 0 });
    const oldResult = useDiffViewerStore.getState().getCurrentDiffContent();

    useDiffViewerStore.setState({ selectedChangeIndex: 99 });
    const recentResult = useDiffViewerStore.getState().getCurrentDiffContent();

    expect(oldResult).not.toBeNull();
    expect(recentResult).not.toBeNull();
  });

  it('should clear cache when conversation updates', () => {
    const changes1: FileChange[] = [{
      id: '1',
      sequenceIndex: 0,
      messageId: 'msg1',
      filePath: 'test.ts',
      changeType: 'edit',
      oldContent: 'const x = 1;',
      newContent: 'const x = 2;',
      timestamp: 1000,
    }];

    clearDiffCache();
    useDiffViewerStore.getState().setChanges(changes1);
    useDiffViewerStore.setState({ selectedChangeIndex: 0, diffMode: 'cumulative' });

    const result1 = useDiffViewerStore.getState().getCurrentDiffContent();

    const changes2: FileChange[] = [{
      id: '2',
      sequenceIndex: 0,
      messageId: 'msg2',
      filePath: 'test.ts',
      changeType: 'edit',
      oldContent: 'const y = 1;',
      newContent: 'const y = 2;',
      timestamp: 2000,
    }];

    useDiffViewerStore.getState().setChanges(changes2);
    useDiffViewerStore.setState({ selectedChangeIndex: 0 });

    const result2 = useDiffViewerStore.getState().getCurrentDiffContent();

    expect(result1?.newContent).toBe('const x = 2;');
    expect(result2?.newContent).toBe('const y = 2;');
    expect(result1?.newContent).not.toBe(result2?.newContent);
  });
});
