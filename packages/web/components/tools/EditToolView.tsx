"use client";
import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const [expanded, setExpanded] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const totalLines = Math.max(oldLines.length, newLines.length);
  const COLLAPSE_THRESHOLD = 10;
  const shouldCollapse = totalLines > COLLAPSE_THRESHOLD;

  const displayOldLines = shouldCollapse && !expanded
    ? oldLines.slice(0, COLLAPSE_THRESHOLD)
    : oldLines;

  const displayNewLines = shouldCollapse && !expanded
    ? newLines.slice(0, COLLAPSE_THRESHOLD)
    : newLines;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-xs text-red-500 mb-1 font-semibold">- Removed</div>
          <pre className="text-xs font-mono overflow-x-auto bg-red-500/10 border border-red-500/20 rounded p-2">
            {displayOldLines.map((line, i) => (
              <div key={i} className="text-red-400">
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
        <div>
          <div className="text-xs text-emerald-500 mb-1 font-semibold">+ Added</div>
          <pre className="text-xs font-mono overflow-x-auto bg-emerald-500/10 border border-emerald-500/20 rounded p-2">
            {displayNewLines.map((line, i) => (
              <div key={i} className="text-emerald-400">
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      </div>
      {shouldCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
        >
          {expanded ? "Show less" : `Show all ${totalLines} lines`}
        </button>
      )}
    </div>
  );
}

export function EditToolView({ input, output }: ToolViewProps) {
  const filePath = input?.file_path || '';
  const fileName = filePath.split('/').pop() || 'file';

  if (input?.old_string && input?.new_string) {
    return (
      <div className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold">File:</span> {fileName}
        </div>
        <DiffView oldStr={input.old_string} newStr={input.new_string} />
      </div>
    );
  }

  if (input?.content) {
    const contentLines = input.content.split('\n');
    const lineCount = contentLines.length;

    return (
      <div className="p-4 space-y-3">
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold">File:</span> {fileName} ({lineCount} lines)
        </div>
        <div className="text-xs text-emerald-500 mb-1 font-semibold">+ Created</div>
        <pre className="text-xs font-mono overflow-x-auto bg-emerald-500/10 border border-emerald-500/20 rounded p-2 max-h-64">
          <code className="text-emerald-400">{input.content}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="p-4 text-sm text-muted-foreground">
      {output ? String(output) : 'File modified'}
    </div>
  );
}
