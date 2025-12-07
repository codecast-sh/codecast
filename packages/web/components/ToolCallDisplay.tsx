"use client";
import { useState } from "react";

interface ToolCallDisplayProps {
  name: string;
  input?: string;
  output?: string;
  timestamp: number;
}

function CollapsibleContent({ content, label }: { content: string; label: string }) {
  const [contentExpanded, setContentExpanded] = useState(false);
  const lines = content.split('\n');
  const lineCount = lines.length;
  const COLLAPSE_THRESHOLD = 12;
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD;

  const displayContent = shouldCollapse && !contentExpanded
    ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n')
    : content;

  return (
    <div>
      <div className="text-xs text-sol-base0 mb-1 flex items-center justify-between">
        <span>{label}</span>
        {shouldCollapse && (
          <span className="text-sol-base00">
            {lineCount} lines
          </span>
        )}
      </div>
      <pre className="text-sol-base1 font-mono text-xs overflow-x-auto">
        {displayContent}
      </pre>
      {shouldCollapse && (
        <button
          onClick={() => setContentExpanded(!contentExpanded)}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          {contentExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function ToolCallDisplay({ name, input, output, timestamp }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 border border-sol-base01 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 bg-sol-base02/50 flex items-center justify-between text-left hover:bg-sol-base02 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs bg-slate-700 px-2 py-0.5 rounded text-sol-base1">
            Tool
          </span>
          <span className="text-sm font-medium text-white">{name}</span>
        </div>
        <span className="text-sol-base0 text-xs">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="p-4 bg-sol-base02/50 text-sm space-y-3">
          {input && (
            <CollapsibleContent content={input} label="Input" />
          )}
          {output && (
            <CollapsibleContent content={output} label="Output" />
          )}
        </div>
      )}
    </div>
  );
}
