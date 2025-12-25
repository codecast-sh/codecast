"use client";

import { useState } from "react";

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
  const output: Array<DiffLine | 'separator'> = [];
  let lastShown = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (showLine.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        output.push('separator');
      }
      output.push(allLines[i]);
      lastShown = i;
    }
  }

  // Count actual lines (not separators)
  const totalLines = output.filter(item => item !== 'separator').length;
  const needsTruncation = totalLines > maxLines && !fullyExpanded;

  // Truncate output if needed
  let displayOutput = output;
  if (needsTruncation) {
    let lineCount = 0;
    const truncated: typeof output = [];
    for (const item of output) {
      if (item === 'separator') {
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
          if (item === 'separator') {
            return (
              <div key={`sep-${i}`} className="text-center py-0.5 text-sol-text-dim">
                ···
              </div>
            );
          }
          const { type, content, oldNum, newNum } = item;
          const lineNum = type === 'removed' ? oldNum : newNum;
          const lineNumStr = lineNum !== undefined ? String(lineNum).padStart(lineNumWidth) : ' '.repeat(lineNumWidth);
          const prefix = type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
          const bgClass = type === 'added'
            ? 'bg-sol-green/10'
            : type === 'removed'
            ? 'bg-sol-red/10'
            : '';
          const textClass = type === 'added'
            ? 'text-sol-green'
            : type === 'removed'
            ? 'text-sol-red'
            : 'text-sol-text-muted';

          return (
            <div key={i} className={`whitespace-pre ${bgClass}`}>
              <span className="select-none text-sol-text-dim">{lineNumStr}</span>
              <span className={`select-none ${textClass}`}> {prefix} </span>
              <span className={textClass}>{content}</span>
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
