"use client";

import { useState } from "react";
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
import "prismjs/themes/prism-tomorrow.css";

function computeDiff(oldLines: string[], newLines: string[]): Array<{ type: 'added' | 'removed' | 'context'; content: string }> {
  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: Array<{ type: 'added' | 'removed' | 'context'; content: string }> = [];
  let i = m, j = n;
  const temp: typeof result = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'context', content: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'removed', content: oldLines[i - 1] });
      i--;
    }
  }

  return temp.reverse();
}

function highlightCode(code: string, language?: string): string {
  if (!language) return code;

  try {
    const grammar = Prism.languages[language];
    if (!grammar) return code;

    return Prism.highlight(code, grammar, language);
  } catch (e) {
    return code;
  }
}

export function DiffView({ oldStr, newStr, contextLines = 3, startLine = 1, maxLines = 10, language }: { oldStr: string; newStr: string; contextLines?: number; startLine?: number; maxLines?: number; language?: string }) {
  const [fullyExpanded, setFullyExpanded] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const changes = computeDiff(oldLines, newLines);

  // Build flat list with line numbers
  type DiffLine = { type: 'added' | 'removed' | 'context'; content: string; oldNum?: number; newNum?: number };
  const allLines: DiffLine[] = [];
  let oldLineNum = startLine;
  let newLineNum = startLine;

  for (const change of changes) {
    if (change.type === 'added') {
      allLines.push({ ...change, newNum: newLineNum++ });
    } else if (change.type === 'removed') {
      allLines.push({ ...change, oldNum: oldLineNum++ });
    } else {
      allLines.push({ ...change, oldNum: oldLineNum++, newNum: newLineNum++ });
    }
  }

  // Mark which context lines to show (within N lines of a change)
  const showLine = new Set<number>();
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].type !== 'context') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(allLines.length - 1, i + contextLines); j++) {
        showLine.add(j);
      }
    }
  }

  // Build output with separators for gaps
  type HunkHeader = { type: 'hunk'; oldStart: number; oldCount: number; newStart: number; newCount: number; skippedLines: number };
  const output: Array<DiffLine | HunkHeader> = [];
  let lastShown = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (showLine.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        const skippedCount = i - lastShown - 1;
        const prevLine = allLines[lastShown];
        const nextLine = allLines[i];
        output.push({
          type: 'hunk',
          oldStart: (prevLine.oldNum || prevLine.newNum || 0) + 1,
          oldCount: skippedCount,
          newStart: (prevLine.newNum || prevLine.oldNum || 0) + 1,
          newCount: skippedCount,
          skippedLines: skippedCount,
        });
      }
      output.push(allLines[i]);
      lastShown = i;
    }
  }

  // Count actual lines (not hunk headers)
  const totalLines = output.filter(item => !('type' in item && item.type === 'hunk')).length;
  const needsTruncation = totalLines > maxLines && !fullyExpanded;

  // Truncate output if needed
  let displayOutput = output;
  if (needsTruncation) {
    let lineCount = 0;
    const truncated: typeof output = [];
    for (const item of output) {
      if ('type' in item && item.type === 'hunk') {
        truncated.push(item);
      } else {
        if (lineCount < maxLines) {
          truncated.push(item);
          lineCount++;
        }
      }
    }
    displayOutput = truncated;
  }

  const maxLineNum = Math.max(oldLineNum, newLineNum);
  const lineNumWidth = String(maxLineNum).length;

  return (
    <div className="font-mono text-xs overflow-x-auto">
      {language && (
        <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
          {language}
        </div>
      )}
      <div className="p-2">
        {displayOutput.map((item, i) => {
          if ('type' in item && item.type === 'hunk') {
            return (
              <div key={`hunk-${i}`} className="py-1 px-2 my-1 bg-sol-blue/10 text-sol-blue text-[10px] font-mono rounded">
                @@ -{item.oldStart},{item.oldCount} +{item.newStart},{item.newCount} @@ <span className="text-sol-text-dim">({item.skippedLines} lines hidden)</span>
              </div>
            );
          }
          const { type, content, oldNum, newNum } = item as DiffLine;
          const lineNum = type === 'removed' ? oldNum : newNum;
          const lineNumStr = lineNum !== undefined ? String(lineNum).padStart(lineNumWidth) : ' '.repeat(lineNumWidth);
          const prefix = type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
          const bgClass = type === 'added'
            ? 'bg-sol-green/25 border-l-2 border-sol-green'
            : type === 'removed'
            ? 'bg-sol-red/25 border-l-2 border-sol-red'
            : '';
          const textClass = type === 'added'
            ? 'text-sol-green'
            : type === 'removed'
            ? 'text-sol-red'
            : 'text-sol-text-muted';
          const prefixClass = type === 'added'
            ? 'text-sol-green font-bold'
            : type === 'removed'
            ? 'text-sol-red font-bold'
            : 'text-sol-text-dim';

          const shouldHighlight = type === 'context' && language;
          const highlightedContent = shouldHighlight ? highlightCode(content, language) : null;

          return (
            <div key={i} className={`whitespace-pre ${bgClass}`}>
              <span className="select-none text-sol-text-dim">{lineNumStr}</span>
              <span className={`select-none ${prefixClass}`}> {prefix} </span>
              {shouldHighlight ? (
                <span dangerouslySetInnerHTML={{ __html: highlightedContent! }} />
              ) : (
                <span className={textClass}>{content}</span>
              )}
            </div>
          );
        })}
        {needsTruncation && (
          <button
            onClick={() => setFullyExpanded(true)}
            className="mt-1 text-[10px] text-sol-blue hover:text-sol-cyan"
          >
            show {totalLines - maxLines} more lines
          </button>
        )}
        {fullyExpanded && totalLines > maxLines && (
          <button
            onClick={() => setFullyExpanded(false)}
            className="mt-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted"
          >
            collapse
          </button>
        )}
      </div>
    </div>
  );
}
