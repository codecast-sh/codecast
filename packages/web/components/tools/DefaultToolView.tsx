import { useState } from "react";
import type { ToolViewProps } from "@/lib/toolRegistry";

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
      <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between">
        <span>{label}</span>
        {shouldCollapse && (
          <span className="text-muted-foreground/80">
            {lineCount} lines
          </span>
        )}
      </div>
      <pre className="text-foreground/90 font-mono text-xs overflow-x-auto bg-muted/50 rounded p-2">
        {displayContent}
      </pre>
      {shouldCollapse && (
        <button
          onClick={() => setContentExpanded(!contentExpanded)}
          className="mt-2 text-xs text-blue-500 hover:text-blue-400 transition-colors select-none"
        >
          {contentExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function DefaultToolView({ name, input, output }: ToolViewProps) {
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

  return (
    <div className="p-4 space-y-3">
      {input && (
        <CollapsibleContent content={inputStr} label="Input" />
      )}
      {output && (
        <CollapsibleContent content={outputStr} label="Output" />
      )}
    </div>
  );
}
