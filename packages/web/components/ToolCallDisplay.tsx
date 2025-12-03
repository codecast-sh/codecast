"use client";
import { useState } from "react";

interface ToolCallDisplayProps {
  name: string;
  input?: string;
  output?: string;
  timestamp: number;
}

export function ToolCallDisplay({ name, input, output, timestamp }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-2 border border-slate-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 bg-slate-800/50 flex items-center justify-between text-left hover:bg-slate-800"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300">
            Tool
          </span>
          <span className="text-sm font-medium text-white">{name}</span>
        </div>
        <span className="text-slate-400 text-xs">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="p-4 bg-slate-900/50 text-sm">
          {input && (
            <div className="mb-3">
              <div className="text-xs text-slate-400 mb-1">Input</div>
              <pre className="text-slate-300 font-mono text-xs overflow-x-auto">
                {input}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="text-xs text-slate-400 mb-1">Output</div>
              <pre className="text-slate-300 font-mono text-xs overflow-x-auto max-h-48 overflow-y-auto">
                {output.substring(0, 2000)}{output.length > 2000 ? "..." : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
