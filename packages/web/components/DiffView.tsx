import { useState, useMemo, memo } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-yaml";
import type { PatchHunk } from "../lib/patchParser";

// The LCS matrix below is O(m*n) in time and memory; past this many cells we
// give up on a minimal diff and render the changed region as remove-all/add-all.
const MAX_LCS_CELLS = 500_000;

export function computeDiff(oldLines: string[], newLines: string[]): Array<{ type: 'added' | 'removed' | 'context'; content: string }> {
  const totalOld = oldLines.length;
  const totalNew = newLines.length;

  // Trim common prefix/suffix so the quadratic LCS only sees the changed
  // middle. Identical inputs (e.g. a Read result rendered through DiffView)
  // resolve here in linear time with no matrix at all.
  const minLen = Math.min(totalOld, totalNew);
  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[totalOld - 1 - suffix] === newLines[totalNew - 1 - suffix]
  ) suffix++;

  const result: Array<{ type: 'added' | 'removed' | 'context'; content: string }> = [];
  for (let k = 0; k < prefix; k++) result.push({ type: 'context', content: oldLines[k] });

  const m = totalOld - prefix - suffix;
  const n = totalNew - prefix - suffix;

  if (m > 0 && n > 0 && m * n > MAX_LCS_CELLS) {
    for (let k = 0; k < m; k++) result.push({ type: 'removed', content: oldLines[prefix + k] });
    for (let k = 0; k < n; k++) result.push({ type: 'added', content: newLines[prefix + k] });
  } else if (m > 0 || n > 0) {
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    let i = m, j = n;
    const temp: typeof result = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[prefix + i - 1] === newLines[prefix + j - 1]) {
        temp.push({ type: 'context', content: oldLines[prefix + i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        temp.push({ type: 'added', content: newLines[prefix + j - 1] });
        j--;
      } else {
        temp.push({ type: 'removed', content: oldLines[prefix + i - 1] });
        i--;
      }
    }
    for (let k = temp.length - 1; k >= 0; k--) result.push(temp[k]);
  }

  for (let k = suffix; k > 0; k--) result.push({ type: 'context', content: oldLines[totalOld - k] });
  return result;
}

function highlightCode(code: string, language?: string): string {
  if (!language) return escapeHtml(code);

  try {
    const grammar = Prism.languages[language];
    if (!grammar) return escapeHtml(code);
    return Prism.highlight(code, grammar, language);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface WordDiffToken {
  text: string;
  highlighted: boolean;
}

function computeWordDiff(oldLine: string, newLine: string): { oldTokens: WordDiffToken[]; newTokens: WordDiffToken[] } {
  let prefixLen = 0;
  const minLen = Math.min(oldLine.length, newLine.length);
  while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldPrefix = oldLine.slice(0, prefixLen);
  const oldMiddle = oldLine.slice(prefixLen, oldLine.length - suffixLen);
  const oldSuffix = oldLine.slice(oldLine.length - suffixLen);

  const newPrefix = newLine.slice(0, prefixLen);
  const newMiddle = newLine.slice(prefixLen, newLine.length - suffixLen);
  const newSuffix = newLine.slice(newLine.length - suffixLen);

  const oldTokens: WordDiffToken[] = [];
  if (oldPrefix) oldTokens.push({ text: oldPrefix, highlighted: false });
  if (oldMiddle) oldTokens.push({ text: oldMiddle, highlighted: true });
  if (oldSuffix) oldTokens.push({ text: oldSuffix, highlighted: false });

  const newTokens: WordDiffToken[] = [];
  if (newPrefix) newTokens.push({ text: newPrefix, highlighted: false });
  if (newMiddle) newTokens.push({ text: newMiddle, highlighted: true });
  if (newSuffix) newTokens.push({ text: newSuffix, highlighted: false });

  return { oldTokens, newTokens };
}

function renderTokensWithHighlight(
  tokens: WordDiffToken[],
  highlightClass: string,
  language?: string
): string {
  return tokens.map(t => {
    const html = language ? highlightCode(t.text, language) : escapeHtml(t.text);
    if (t.highlighted) {
      return `<span class="${highlightClass}">${html}</span>`;
    }
    return html;
  }).join("");
}

type DiffLineType = 'added' | 'removed' | 'context';

interface FlatDiffLine {
  type: DiffLineType;
  content: string;
  oldNum?: number;
  newNum?: number;
  wordDiffHtml?: string;
  html?: string;
}

interface HunkSeparator {
  type: 'separator';
}

type DisplayItem = FlatDiffLine | HunkSeparator;

function hunksToDisplayItems(
  hunks: PatchHunk[],
  language?: string
): { items: DisplayItem[]; maxLineNum: number } {
  const items: DisplayItem[] = [];
  let maxLineNum = 0;

  for (let h = 0; h < hunks.length; h++) {
    if (h > 0) {
      items.push({ type: 'separator' });
    }

    const hunk = hunks[h];
    const lines = hunk.lines;

    const processed = lines.map(l => ({
      type: (l.type === 'addition' ? 'added' : l.type === 'deletion' ? 'removed' : 'context') as DiffLineType,
      content: l.content,
      oldNum: l.oldLineNumber,
      newNum: l.newLineNumber,
    }));

    const withWordDiff = applyWordDiffToBlock(processed, language);

    for (const line of withWordDiff) {
      if (line.oldNum && line.oldNum > maxLineNum) maxLineNum = line.oldNum;
      if (line.newNum && line.newNum > maxLineNum) maxLineNum = line.newNum;
      items.push(line);
    }
  }

  return { items, maxLineNum };
}

function diffToDisplayItems(
  changes: Array<{ type: 'added' | 'removed' | 'context'; content: string }>,
  startLine: number,
  contextLines: number,
  language?: string
): { items: DisplayItem[]; maxLineNum: number; totalCodeLines: number } {
  const allLines: FlatDiffLine[] = [];
  let oldLineNum = startLine;
  let newLineNum = startLine;

  for (const change of changes) {
    if (change.type === 'added') {
      allLines.push({ type: 'added', content: change.content, newNum: newLineNum++ });
    } else if (change.type === 'removed') {
      allLines.push({ type: 'removed', content: change.content, oldNum: oldLineNum++ });
    } else {
      allLines.push({ type: 'context', content: change.content, oldNum: oldLineNum++, newNum: newLineNum++ });
    }
  }

  const hasChanges = allLines.some(l => l.type !== 'context');
  const showLine = new Set<number>();
  if (!hasChanges) {
    for (let i = 0; i < allLines.length; i++) showLine.add(i);
  } else {
    for (let i = 0; i < allLines.length; i++) {
      if (allLines[i].type !== 'context') {
        for (let j = Math.max(0, i - contextLines); j <= Math.min(allLines.length - 1, i + contextLines); j++) {
          showLine.add(j);
        }
      }
    }
  }

  const items: DisplayItem[] = [];
  let lastShown = -1;

  const visibleLines: FlatDiffLine[] = [];
  const visibleIndices: number[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (showLine.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        items.push({ type: 'separator' });
      }
      visibleLines.push(allLines[i]);
      visibleIndices.push(items.length);
      items.push(allLines[i]);
      lastShown = i;
    }
  }

  const withWordDiff = applyWordDiffToBlock(visibleLines, language);
  for (let k = 0; k < withWordDiff.length; k++) {
    items[visibleIndices[k]] = withWordDiff[k];
  }

  const maxLineNum = Math.max(oldLineNum, newLineNum) - 1;
  const totalCodeLines = items.filter(i => i.type !== 'separator').length;

  return { items, maxLineNum, totalCodeLines };
}

function applyWordDiffToBlock(lines: FlatDiffLine[], language?: string): FlatDiffLine[] {
  const result = [...lines];

  let i = 0;
  while (i < result.length) {
    if (result[i].type === 'removed') {
      const removeStart = i;
      while (i < result.length && result[i].type === 'removed') i++;
      const removeEnd = i;

      const addStart = i;
      while (i < result.length && result[i].type === 'added') i++;
      const addEnd = i;

      const removeCount = removeEnd - removeStart;
      const addCount = addEnd - addStart;
      const pairCount = Math.min(removeCount, addCount);

      for (let p = 0; p < pairCount; p++) {
        const ri = removeStart + p;
        const ai = addStart + p;
        const { oldTokens, newTokens } = computeWordDiff(result[ri].content, result[ai].content);

        if (oldTokens.some(t => t.highlighted) || newTokens.some(t => t.highlighted)) {
          result[ri] = {
            ...result[ri],
            wordDiffHtml: renderTokensWithHighlight(oldTokens, "diff-word-removed", language),
          };
          result[ai] = {
            ...result[ai],
            wordDiffHtml: renderTokensWithHighlight(newTokens, "diff-word-added", language),
          };
        }
      }
      continue;
    }
    i++;
  }

  return result;
}

interface DiffViewProps {
  oldStr?: string;
  newStr?: string;
  hunks?: PatchHunk[];
  contextLines?: number;
  startLine?: number;
  maxLines?: number;
  language?: string;
  showLineNumbers?: boolean;
}

export const DiffView = memo(function DiffView({
  oldStr,
  newStr,
  hunks,
  contextLines = 3,
  startLine = 1,
  maxLines = 10,
  language,
  showLineNumbers = false,
}: DiffViewProps) {
  const [fullyExpanded, setFullyExpanded] = useState(false);

  const { items, totalCodeLines, gutterCh } = useMemo(() => {
    let items: DisplayItem[];
    let maxLineNum: number;
    if (hunks && hunks.length > 0) {
      ({ items, maxLineNum } = hunksToDisplayItems(hunks, language));
    } else {
      const oldLines = (oldStr || "").split('\n');
      const newLines = (newStr || "").split('\n');
      const changes = computeDiff(oldLines, newLines);
      ({ items, maxLineNum } = diffToDisplayItems(changes, startLine, contextLines, language));
    }
    // Highlight once here, not in render — this component sits inside the
    // frequently re-rendering conversation tree, and Prism per line per render
    // froze the page whenever a large block was open.
    items = items.map(item =>
      item.type === 'separator'
        ? item
        : { ...item, html: item.wordDiffHtml ?? highlightCode(item.content, language) },
    );
    const totalCodeLines = items.filter(i => i.type !== 'separator').length;
    return { items, totalCodeLines, gutterCh: String(Math.max(maxLineNum, 1)).length };
  }, [hunks, oldStr, newStr, startLine, contextLines, language]);

  const needsTruncation = totalCodeLines > maxLines && !fullyExpanded;

  const displayItems = useMemo(() => {
    if (!needsTruncation) return items;
    let lineCount = 0;
    const truncated: DisplayItem[] = [];
    for (const item of items) {
      if (item.type === 'separator') {
        truncated.push(item);
      } else {
        if (lineCount < maxLines) {
          truncated.push(item);
          lineCount++;
        }
      }
    }
    return truncated;
  }, [items, needsTruncation, maxLines]);

  return (
    <div className="code-block-resizable group font-mono text-[13px] leading-[22px]">
      <div className="cb-hscroll">
        <div className="min-w-fit">
        {displayItems.map((item, i) => {
          if (item.type === 'separator') {
            return (
              <div key={`sep-${i}`} className="text-center text-[11px] text-sol-text-dim/40 select-none">
                &#8943;
              </div>
            );
          }

          const line = item as FlatDiffLine;
          const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
          const rowBg = line.type === 'added'
            ? 'diff-line-added'
            : line.type === 'removed'
            ? 'diff-line-removed'
            : '';
          const prefixColor = line.type === 'added'
            ? 'text-sol-green/60'
            : line.type === 'removed'
            ? 'text-sol-red/60'
            : 'text-transparent';

          return (
            <div key={i} className={`${rowBg} whitespace-pre`}>
              {showLineNumbers && (
                <span
                  className="select-none inline-block text-right font-medium text-sol-text-dim opacity-55 pl-1 pr-3 mr-3 border-r border-sol-border/30"
                  style={{ minWidth: `calc(${gutterCh}ch + 1rem)` }}
                >
                  {line.newNum ?? line.oldNum ?? ''}
                </span>
              )}
              <span className={`select-none ${prefixColor}`}>{prefix} </span>
              <span dangerouslySetInnerHTML={{ __html: line.html || ' ' }} />
            </div>
          );
        })}
        </div>
      </div>
      {needsTruncation && (
        <button
          onClick={() => setFullyExpanded(true)}
          className="block w-full text-center py-2 sm:py-1 text-xs sm:text-[11px] text-sol-blue hover:text-sol-cyan transition-colors"
        >
          show {totalCodeLines - maxLines} more lines
        </button>
      )}
      {fullyExpanded && totalCodeLines > maxLines && (
        <button
          onClick={() => setFullyExpanded(false)}
          className="block w-full text-center py-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
        >
          collapse
        </button>
      )}
    </div>
  );
});
