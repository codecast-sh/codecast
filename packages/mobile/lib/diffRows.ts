// The rows a diff draws on a phone: changed lines with a few lines of context
// around them, and one "N unchanged lines" row for every longer run that is
// folded away. Used by the ```cast-diff fence and the Edit tool card, so a
// change reads the same wherever it appears. Pure, so it is tested headless.

import { diffLines } from 'diff';
import type { PatchHunk, PatchLine } from '@codecast/convex/convex/fileChanges/patchParser';

export type DiffRow =
  | { kind: 'line'; type: PatchLine['type']; content: string; num?: number }
  | { kind: 'gap'; count: number };

export const DIFF_CONTEXT = 3;

/** One hunk spanning the whole edit, from the text before and after it. */
export function editHunk(oldStr: string, newStr: string, startLine = 1): PatchHunk {
  const lines: PatchLine[] = [];
  let oldNum = startLine;
  let newNum = startLine;
  for (const part of diffLines(oldStr, newStr)) {
    const body = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value;
    for (const content of body.split('\n')) {
      if (part.added) lines.push({ type: 'addition', content, newLineNumber: newNum++ });
      else if (part.removed) lines.push({ type: 'deletion', content, oldLineNumber: oldNum++ });
      else lines.push({ type: 'context', content, oldLineNumber: oldNum++, newLineNumber: newNum++ });
    }
  }
  return { oldStart: startLine, oldCount: oldNum - startLine, newStart: startLine, newCount: newNum - startLine, lines };
}

/**
 * Hunks into rows. A run of unchanged lines keeps `context` lines next to each
 * change and folds the rest into a gap row; so does the space between hunks.
 * `context: Infinity` keeps every line.
 */
export function diffRows(hunks: PatchHunk[], context = DIFF_CONTEXT): DiffRow[] {
  const rows: DiffRow[] = [];
  let prevOldEnd: number | null = null;
  for (const hunk of hunks) {
    if (prevOldEnd != null && hunk.oldStart > prevOldEnd) rows.push({ kind: 'gap', count: hunk.oldStart - prevOldEnd });
    prevOldEnd = hunk.oldStart + hunk.oldCount;
    const ls = hunk.lines;
    let i = 0;
    while (i < ls.length) {
      if (ls[i].type !== 'context') {
        rows.push(lineRow(ls[i++]));
        continue;
      }
      let j = i;
      while (j < ls.length && ls[j].type === 'context') j++;
      // Context kept before the next change and after the previous one.
      const head = i === 0 ? 0 : context;
      const tail = j === ls.length ? 0 : context;
      if (j - i > head + tail + 1) {
        for (let n = i; n < i + head; n++) rows.push(lineRow(ls[n]));
        rows.push({ kind: 'gap', count: j - i - head - tail });
        for (let n = j - tail; n < j; n++) rows.push(lineRow(ls[n]));
      } else {
        for (let n = i; n < j; n++) rows.push(lineRow(ls[n]));
      }
      i = j;
    }
  }
  return rows;
}

function lineRow(l: PatchLine): DiffRow {
  return { kind: 'line', type: l.type, content: l.content, num: l.type === 'deletion' ? l.oldLineNumber : l.newLineNumber };
}

export function diffStats(hunks: PatchHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks) for (const l of h.lines) {
    if (l.type === 'addition') additions++;
    else if (l.type === 'deletion') deletions++;
  }
  return { additions, deletions };
}
