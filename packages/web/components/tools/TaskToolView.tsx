import { useState } from "react";
import { Rocket, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ToolViewProps } from "@/lib/toolRegistry";

const PROMPT_COLLAPSE_THRESHOLD = 200;

export function TaskToolView({ input, output }: ToolViewProps) {
  const description = input?.description || '';
  const prompt = input?.prompt || '';
  const subagentType = input?.subagent_type || 'general';
  const model = input?.model;
  const runInBackground = input?.run_in_background;

  const agentId = output?.agent_id;
  const status = output?.status;
  const result = output?.result;

  const [promptExpanded, setPromptExpanded] = useState(prompt.length < PROMPT_COLLAPSE_THRESHOLD);
  const [resultExpanded, setResultExpanded] = useState(true);

  const resultText = typeof result === 'string' ? result : result ? JSON.stringify(result, null, 2) : '';

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
            {status && (
              <span className={`px-2 py-0.5 rounded border ${
                status === 'completed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                status === 'running' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
                status === 'error' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                'bg-muted text-muted-foreground border-muted'
              }`}>
                {status}
              </span>
            )}
          </div>
        </div>
      </div>

      {prompt && (
        <div className="rounded border border-muted overflow-hidden">
          <button
            onClick={() => setPromptExpanded(!promptExpanded)}
            className="w-full px-3 py-2 bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            {promptExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">Prompt</span>
            {!promptExpanded && (
              <span className="text-xs text-muted-foreground/60 truncate flex-1">
                {prompt.slice(0, 80)}{prompt.length > 80 ? '...' : ''}
              </span>
            )}
          </button>
          {promptExpanded && (
            <div className="p-3 bg-muted/20 text-sm text-foreground/90 whitespace-pre-wrap border-t border-muted">
              {prompt}
            </div>
          )}
        </div>
      )}

      {agentId && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Agent:</span>
          <code className="px-2 py-0.5 bg-black/50 text-cyan-400 rounded font-mono text-[11px]">
            {agentId}
          </code>
        </div>
      )}

      {resultText && (
        <div className="rounded border border-muted overflow-hidden">
          <button
            onClick={() => setResultExpanded(!resultExpanded)}
            className="w-full px-3 py-2 bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            {resultExpanded ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="text-xs font-medium text-foreground">Result</span>
          </button>
          {resultExpanded && (
            <div className="p-3 bg-muted/20 border-t border-muted">
              <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-black/50 prose-pre:border prose-pre:border-muted prose-code:text-cyan-400 prose-code:bg-black/30 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre: ({ children, ...props }) => (
                      <pre className="overflow-x-auto" {...props}>{children}</pre>
                    ),
                    ul: ({ children, ...props }) => (
                      <ul className="list-disc list-inside space-y-1" {...props}>{children}</ul>
                    ),
                    ol: ({ children, ...props }) => (
                      <ol className="list-decimal list-inside space-y-1" {...props}>{children}</ol>
                    ),
                  }}
                >
                  {resultText}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
