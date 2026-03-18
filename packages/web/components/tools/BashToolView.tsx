import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";

function TerminalOutput({ content, type }: { content: string; type: 'stdout' | 'stderr' }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const lineCount = lines.length;
  const COLLAPSE_THRESHOLD = 20;
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD;

  const displayContent = shouldCollapse && !expanded
    ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n')
    : content;

  const typeColor = type === 'stderr' ? 'text-red-400' : 'text-emerald-400';

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between">
        <span className={typeColor}>{type}</span>
        {shouldCollapse && (
          <span className="text-muted-foreground/80">
            {lineCount} lines
          </span>
        )}
      </div>
      <pre className={`${typeColor} font-mono text-xs overflow-x-auto bg-black/50 rounded p-3 border border-muted`}>
        {displayContent}
      </pre>
      {shouldCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-blue-500 hover:text-blue-400 transition-colors select-none"
        >
          {expanded ? "Show less" : `Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  );
}

export function BashToolView({ input, output }: ToolViewProps) {
  const command = input?.command || input?.description || '';
  const stdout = output?.stdout || '';
  const stderr = output?.stderr || '';
  const exitCode = output?.exit_code;

  return (
    <div className="p-4 space-y-3">
      <div className="bg-black/50 rounded p-3 border border-muted">
        <div className="text-xs text-emerald-500 mb-1">$</div>
        <pre className="text-sm font-mono text-emerald-400 overflow-x-auto">
          {command}
        </pre>
      </div>

      {stdout && (
        <TerminalOutput content={stdout} type="stdout" />
      )}

      {stderr && (
        <TerminalOutput content={stderr} type="stderr" />
      )}

      {exitCode !== undefined && exitCode !== 0 && (
        <div className="text-xs text-red-500">
          Exit code: {exitCode}
        </div>
      )}

      {!stdout && !stderr && !exitCode && (
        <div className="text-xs text-muted-foreground italic">
          No output
        </div>
      )}
    </div>
  );
}
