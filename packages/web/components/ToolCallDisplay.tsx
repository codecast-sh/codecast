"use client";
import { useState } from "react";
import { getToolConfig, getToolColor } from "@/lib/toolRegistry";

interface ToolCallDisplayProps {
  name: string;
  input?: any;
  output?: any;
  timestamp: number;
}

export function ToolCallDisplay({ name, input, output, timestamp }: ToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const toolConfig = getToolConfig(name);
  const ToolIcon = toolConfig.icon;
  const colorClasses = getToolColor(toolConfig.color);
  const ToolComponent = toolConfig.component;

  const parsedInput = typeof input === 'string' ? JSON.parse(input || '{}') : input;
  const parsedOutput = typeof output === 'string' ? JSON.parse(output || '{}') : output;

  const summary = toolConfig.extractSummary?.(parsedInput, parsedOutput) || toolConfig.title;

  return (
    <div className="my-2 border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 bg-muted/30 flex items-center justify-between text-left hover:bg-muted/50 transition-colors select-none"
      >
        <div className="flex items-center gap-3">
          <div className={`p-1.5 rounded border ${colorClasses}`}>
            <ToolIcon className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">
              {summary}
            </div>
            <div className="text-xs text-muted-foreground">
              {name}
            </div>
          </div>
        </div>
        <span className="text-muted-foreground text-xs">
          {expanded ? "▼" : "▶"}
        </span>
      </button>
      {expanded && (
        <div className="bg-muted/20 border-t border-border">
          <ToolComponent
            name={name}
            input={parsedInput}
            output={parsedOutput}
            timestamp={timestamp}
          />
        </div>
      )}
    </div>
  );
}
