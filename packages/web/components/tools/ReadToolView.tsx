"use client";
import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";

export function ReadToolView({ input, output }: ToolViewProps) {
  const [expanded, setExpanded] = useState(false);

  const filePath = input?.file_path || '';
  const fileName = filePath.split('/').pop() || 'file';

  const content = output?.file?.content || output?.content || '';
  const startLine = output?.file?.startLine || input?.offset || 1;
  const numLines = output?.file?.numLines || 0;
  const totalLines = output?.file?.totalLines || numLines;

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
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD;

  const displayLines = shouldCollapse && !expanded
    ? lines.slice(0, COLLAPSE_THRESHOLD)
    : lines;

  return (
    <div className="p-4 space-y-3">
      <div className="text-sm text-muted-foreground flex items-center justify-between">
        <div>
          <span className="font-semibold">File:</span> {fileName}
        </div>
        <div className="text-xs">
          {totalLines > numLines ? (
            <span>Lines {startLine}-{startLine + numLines - 1} of {totalLines}</span>
          ) : (
            <span>{totalLines} lines</span>
          )}
        </div>
      </div>

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

      {shouldCollapse && (
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
