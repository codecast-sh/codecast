import { describe, it, expect } from 'bun:test';
import { computeCumulativeDiff, getCumulativeDiffForFile } from '../cumulativeDiff';
import type { FileChange } from '../../store/diffViewerStore';

describe('cumulativeDiff', () => {
  describe('computeCumulativeDiff', () => {
    it('a write carrying the text it replaced keeps that text as the original', () => {
      const changes: FileChange[] = [
        { id: 'w', sequenceIndex: 0, messageId: 'm', filePath: 'a.ts', changeType: 'write', oldContent: 'before', newContent: 'after', timestamp: 1 },
      ];
      expect(computeCumulativeDiff(changes)).toEqual([
        { filePath: 'a.ts', oldContent: 'before', newContent: 'after', changeCount: 1 },
      ]);
    });

    it('a delete empties the file and marks it deleted', () => {
      const changes: FileChange[] = [
        { id: 'e', sequenceIndex: 0, messageId: 'm', filePath: 'a.ts', changeType: 'edit', oldContent: 'x', newContent: 'y', timestamp: 1 },
        { id: 'd', sequenceIndex: 1, messageId: 'm', filePath: 'a.ts', changeType: 'delete', oldContent: 'a y b', newContent: '', timestamp: 2 },
      ];
      expect(computeCumulativeDiff(changes)).toEqual([
        { filePath: 'a.ts', oldContent: 'a x b', newContent: '', changeCount: 2, deleted: true },
      ]);
    });

    it('a whole-file write after string edits undoes them to recover the original', () => {
      const changes: FileChange[] = [
        { id: 'e1', sequenceIndex: 0, messageId: 'm', filePath: 'a.ts', changeType: 'edit', oldContent: 'one', newContent: '1', timestamp: 1 },
        { id: 'e2', sequenceIndex: 1, messageId: 'm', filePath: 'a.ts', changeType: 'edit', oldContent: 'two', newContent: '2', timestamp: 2 },
        { id: 'w', sequenceIndex: 2, messageId: 'm', filePath: 'a.ts', changeType: 'write', oldContent: '1 2 three', newContent: '1 2 3', timestamp: 3 },
      ];
      expect(computeCumulativeDiff(changes)).toEqual([
        { filePath: 'a.ts', oldContent: 'one two three', newContent: '1 2 3', changeCount: 3 },
      ]);
    });

    it('handles empty changes array', () => {
      const result = computeCumulativeDiff([]);
      expect(result).toEqual([]);
    });

    it('handles single write change', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'test.ts',
          changeType: 'write',
          newContent: 'console.log("hello");',
          timestamp: 1000,
        },
      ];

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: 'test.ts',
        oldContent: undefined,
        newContent: 'console.log("hello");',
        changeCount: 1,
      });
    });

    it('handles single edit change', () => {
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

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: 'test.ts',
        oldContent: 'const x = 1;',
        newContent: 'const x = 2;',
        changeCount: 1,
      });
    });

    it('combines multiple edits to same file', () => {
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
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 2;',
          newContent: 'const x = 3;',
          timestamp: 2000,
        },
        {
          id: '3',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 3;',
          newContent: 'const x = 4;',
          timestamp: 3000,
        },
      ];

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: 'test.ts',
        oldContent: 'const x = 1;',
        newContent: 'const x = 4;',
        changeCount: 3,
      });
    });

    it('handles write followed by edits', () => {
      const changes: FileChange[] = [
        {
          id: '1',
          sequenceIndex: 0,
          messageId: 'msg1',
          filePath: 'new.ts',
          changeType: 'write',
          newContent: 'export const foo = 1;',
          timestamp: 1000,
        },
        {
          id: '2',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'new.ts',
          changeType: 'edit',
          oldContent: 'export const foo = 1;',
          newContent: 'export const foo = 2;',
          timestamp: 2000,
        },
      ];

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: 'new.ts',
        oldContent: undefined,
        newContent: 'export const foo = 2;',
        changeCount: 2,
      });
    });

    it('handles multiple files', () => {
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

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(2);

      const aResult = result.find(r => r.filePath === 'a.ts');
      expect(aResult).toEqual({
        filePath: 'a.ts',
        oldContent: undefined,
        newContent: 'const a = 10;',
        changeCount: 2,
      });

      const bResult = result.find(r => r.filePath === 'b.ts');
      expect(bResult).toEqual({
        filePath: 'b.ts',
        oldContent: undefined,
        newContent: 'const b = 2;',
        changeCount: 1,
      });
    });

    it('handles out-of-order changes by sorting', () => {
      const changes: FileChange[] = [
        {
          id: '2',
          sequenceIndex: 2,
          messageId: 'msg3',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 2;',
          newContent: 'const x = 3;',
          timestamp: 3000,
        },
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
          id: '3',
          sequenceIndex: 1,
          messageId: 'msg2',
          filePath: 'test.ts',
          changeType: 'edit',
          oldContent: 'const x = 1;',
          newContent: 'const x = 2;',
          timestamp: 2000,
        },
      ];

      const result = computeCumulativeDiff(changes);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        filePath: 'test.ts',
        oldContent: undefined,
        newContent: 'const x = 3;',
        changeCount: 3,
      });
    });

    it('handles large number of changes efficiently', () => {
      const changes: FileChange[] = [];

      for (let i = 0; i < 100; i++) {
        changes.push({
          id: `${i}`,
          sequenceIndex: i,
          messageId: `msg${i}`,
          filePath: `file${i % 10}.ts`,
          changeType: i === 0 ? 'write' : 'edit',
          oldContent: i === 0 ? undefined : `content${i - 1}`,
          newContent: `content${i}`,
          timestamp: 1000 + i,
        });
      }

      const start = performance.now();
      const result = computeCumulativeDiff(changes);
      const duration = performance.now() - start;

      expect(result).toHaveLength(10);
      expect(duration).toBeLessThan(50);
    });
  });

  describe('getCumulativeDiffForFile', () => {
    it('returns null for non-existent file', () => {
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
      ];

      const result = getCumulativeDiffForFile(changes, 'b.ts');
      expect(result).toBeNull();
    });

    it('returns cumulative diff for specific file', () => {
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

      const result = getCumulativeDiffForFile(changes, 'a.ts');

      expect(result).toEqual({
        filePath: 'a.ts',
        oldContent: undefined,
        newContent: 'const a = 10;',
        changeCount: 2,
      });
    });
  });
});
