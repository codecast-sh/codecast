import { useState } from "react";
import { MessageSquare, Radio, StopCircle, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolViewProps } from "@/lib/toolRegistry";

const typeConfig: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  message: { icon: <MessageSquare className="w-4 h-4" />, label: "DM", color: "text-amber-500" },
  broadcast: { icon: <Radio className="w-4 h-4" />, label: "broadcast", color: "text-red-400" },
  shutdown_request: { icon: <StopCircle className="w-4 h-4" />, label: "shutdown", color: "text-red-400" },
  shutdown_response: { icon: <StopCircle className="w-4 h-4" />, label: "shutdown reply", color: "text-red-400" },
  plan_approval_response: { icon: <MessageSquare className="w-4 h-4" />, label: "plan approval", color: "text-cyan-400" },
};

export function SendMessageToolView({ input, output }: ToolViewProps) {
  const [expanded, setExpanded] = useState(false);
  const type = input?.type || "message";
  const recipient = input?.recipient;
  const summary = input?.summary;
  const content = input?.content;

  const cfg = typeConfig[type] || typeConfig.message;

  const targetColor = (() => {
    try {
      const parsed = typeof output === "string" ? JSON.parse(output) : output;
      return parsed?.routing?.targetColor;
    } catch {
      return undefined;
    }
  })();

  const recipientBadgeColor = targetColor
    ? `bg-${targetColor}-500/20 text-${targetColor}-400 border-${targetColor}-500/30`
    : "bg-amber-500/20 text-amber-400 border-amber-500/30";

  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cfg.color}>{cfg.icon}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded border ${recipientBadgeColor} font-mono`}>
          {type === "broadcast" ? "all" : recipient ? `@${recipient}` : "?"}
        </span>
        {summary && <span className="text-sm text-sol-text-secondary">{summary}</span>}
      </div>

      {content && content.length > 0 && (
        <div className="rounded border border-muted overflow-hidden">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full px-3 py-1.5 bg-muted/30 flex items-center gap-2 text-left hover:bg-muted/50 transition-colors"
          >
            {expanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            )}
            <span className="text-xs text-muted-foreground">Content</span>
            {!expanded && (
              <span className="text-xs text-muted-foreground/60 truncate flex-1">
                {content.slice(0, 100)}{content.length > 100 ? "..." : ""}
              </span>
            )}
          </button>
          {expanded && (
            <div className="p-3 bg-muted/20 text-sm text-foreground/90 whitespace-pre-wrap border-t border-muted max-h-64 overflow-y-auto">
              {content}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
