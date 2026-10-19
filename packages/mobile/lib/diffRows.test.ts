import { describe, expect, test } from 'bun:test';
import { parseCastDiff } from '@codecast/web/lib/castDiff';
import { diffRows, diffStats, editHunk } from './diffRows';

const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

describe('diffRows', () => {
  test('an edit keeps three lines of context and folds the rest', () => {
    const after = [...file];
    after[14] = 'changed';
    const rows = diffRows([editHunk(file.join('\n'), after.join('\n'))]);
    expect(rows[0]).toEqual({ kind: 'gap', count: 11 });
    expect(rows.filter((r) => r.kind === 'line').map((r) => r.kind === 'line' && r.type)).toEqual([
      'context', 'context', 'context', 'deletion', 'addition', 'context', 'context', 'context',
    ]);
    expect(rows.at(-1)).toEqual({ kind: 'gap', count: 12 });
    expect(rows.find((r) => r.kind === 'line' && r.type === 'addition')).toMatchObject({ num: 15, content: 'changed' });
  });

  test('a short run between two changes stays whole', () => {
    const after = [...file];
    after[10] = 'a';
    after[16] = 'b';
    const rows = diffRows([editHunk(file.join('\n'), after.join('\n'))]);
    expect(rows.filter((r) => r.kind === 'gap')).toHaveLength(2);
  });

  test('a cast-diff patch with two hunks shows the gap between them', () => {
    const raw = [
      'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts',
      '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
      '@@ -20,3 +20,4 @@', ' t', ' u', '+v', ' w',
    ].join('\n');
    const [f] = parseCastDiff(raw);
    const rows = diffRows(f.hunks);
    expect(rows.filter((r) => r.kind === 'gap')).toEqual([{ kind: 'gap', count: 16 }]);
    expect(diffStats(f.hunks)).toEqual({ additions: 2, deletions: 1 });
  });
});
