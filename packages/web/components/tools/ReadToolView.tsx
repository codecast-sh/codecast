"use client";
import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";
import { MarkdownRenderer, isMarkdownFile, isPlanFile } from "./MarkdownRenderer";

export function ReadToolView({ input, output }: ToolViewProps) {
  const [expanded, setExpanded] = useState(false);

  const filePath = input?.file_path || '';
  const fileName = filePath.split('/').pop() || 'file';

  const content = output?.file?.content || output?.content || '';
  const startLine = output?.file?.startLine || input?.offset || 1;
  const numLines = output?.file?.numLines || 0;
  const totalLines = output?.file?.totalLines || numLines;

  const isMarkdown = isMarkdownFile(filePath);
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isPlan ? 'rendered' : 'raw');

  if (!content) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <div className="mb-2">
          <span className="font-semibold">File:</span> {fileName}
        </div>
        <div className="italic">No content available</div>
      </div>
    );
  }

  const lines = content.split('\n');
  const lineCount = lines.length;
  const COLLAPSE_THRESHOLD = 15;
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD && viewMode === 'raw';

  const displayLines = shouldCollapse && !expanded
    ? lines.slice(0, COLLAPSE_THRESHOLD)
    : lines;

  return (
    <div className="p-4 space-y-3">
      <div className="text-sm text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold">File:</span> {fileName}
          {isPlan && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
              PLAN
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isMarkdown && (
            <div className="flex items-center gap-1 text-xs">
              <button
                onClick={() => setViewMode('raw')}
                className={`px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'raw'
                    ? 'bg-sol-bg-highlight text-sol-text'
                    : 'text-sol-text-dim hover:text-sol-text-muted'
                }`}
              >
                Raw
              </button>
              <button
                onClick={() => setViewMode('rendered')}
                className={`px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'rendered'
                    ? 'bg-sol-bg-highlight text-sol-text'
                    : 'text-sol-text-dim hover:text-sol-text-muted'
                }`}
              >
                Rendered
              </button>
            </div>
          )}
          <div className="text-xs">
            {totalLines > numLines ? (
              <span>Lines {startLine}-{startLine + numLines - 1} of {totalLines}</span>
            ) : (
              <span>{totalLines} lines</span>
            )}
          </div>
        </div>
      </div>

      {viewMode === 'rendered' && isMarkdown ? (
        <div className="rounded border overflow-hidden p-4 bg-muted/50 border-muted">
          <MarkdownRenderer content={content} filePath={filePath} />
        </div>
      ) : (
        <div className="bg-muted/50 rounded border border-muted overflow-hidden">
          <pre className="text-xs font-mono overflow-x-auto p-3">
            {displayLines.map((line: string, i: number) => {
              const lineNum = startLine + i;
              return (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground select-none min-w-[3ch] text-right">
                    {lineNum}
                  </span>
                  <span className="text-foreground/90">{line || ' '}</span>
                </div>
              );
            })}
          </pre>
        </div>
      )}

      {shouldCollapse && viewMode === 'raw' && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
        >
          {expanded ? "Show less" : `Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  );
}
