"use client";
import { Rocket, ExternalLink } from "lucide-react";
import type { ToolViewProps } from "@/lib/toolRegistry";

export function TaskToolView({ input, output }: ToolViewProps) {
  const description = input?.description || '';
  const prompt = input?.prompt || '';
  const subagentType = input?.subagent_type || 'general';
  const model = input?.model;
  const runInBackground = input?.run_in_background;

  const agentId = output?.agent_id;
  const status = output?.status;
  const result = output?.result;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-cyan-500/10 rounded border border-cyan-500/20">
          <Rocket className="w-5 h-5 text-cyan-500" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-foreground mb-1">
            {description || 'Subagent Task'}
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="px-2 py-0.5 bg-cyan-500/10 text-cyan-400 rounded border border-cyan-500/20">
              {subagentType}
            </span>
            {model && (
              <span className="px-2 py-0.5 bg-violet-500/10 text-violet-400 rounded border border-violet-500/20">
                {model}
              </span>
            )}
            {runInBackground && (
              <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 rounded border border-amber-500/20">
                background
              </span>
            )}
          </div>
        </div>
      </div>

      {prompt && (
        <div className="bg-muted/50 rounded p-3 border border-muted">
          <div className="text-xs text-muted-foreground mb-1">Prompt</div>
          <div className="text-sm text-foreground/90 whitespace-pre-wrap">
            {prompt}
          </div>
        </div>
      )}

      {agentId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Agent ID:</span>
          <code className="px-2 py-0.5 bg-black/50 text-cyan-400 rounded font-mono">
            {agentId}
          </code>
          <ExternalLink className="w-3 h-3 text-muted-foreground" />
        </div>
      )}

      {status && (
        <div className="text-xs">
          <span className="text-muted-foreground">Status: </span>
          <span className={
            status === 'completed' ? 'text-emerald-500' :
            status === 'running' ? 'text-blue-500' :
            status === 'error' ? 'text-red-500' :
            'text-muted-foreground'
          }>
            {status}
          </span>
        </div>
      )}

      {result && (
        <div className="bg-muted/50 rounded p-3 border border-muted">
          <div className="text-xs text-muted-foreground mb-1">Result</div>
          <div className="text-sm text-foreground/90 whitespace-pre-wrap">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}
