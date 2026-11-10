import { UsageData } from "../lib/messageReducer";

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return num.toString();
}

export function UsageDisplay({ usage }: { usage: UsageData }) {
  const CONTEXT_LIMIT = 200000;
  const contextPercent = (usage.contextSize / CONTEXT_LIMIT) * 100;
  const isWarning = contextPercent > 80;

  return (
    <div className="flex items-center gap-4 text-xs text-sol-text-muted">
      <div className="flex items-center gap-1">
        <span className="text-sol-text-dim">In:</span>
        <span className="font-mono">{formatNumber(usage.inputTokens)}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="text-sol-text-dim">Out:</span>
        <span className="font-mono">{formatNumber(usage.outputTokens)}</span>
      </div>
      {(usage.cacheCreation > 0 || usage.cacheRead > 0) && (
        <div className="flex items-center gap-1">
          <span className="text-sol-text-dim">Cache:</span>
          <span className="font-mono text-sol-cyan">
            {formatNumber(usage.cacheRead)}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-sol-text-dim">Context:</span>
        <div className="w-24 h-2 bg-sol-bg-alt rounded-full overflow-hidden border border-sol-border/40">
          <div
            className={`h-full transition-all ${
              isWarning ? "bg-red-500" : "bg-sol-green"
            }`}
            style={{ width: `${Math.min(100, contextPercent)}%` }}
          />
        </div>
        <span className={`font-mono ${isWarning ? "text-red-400" : "text-sol-text-muted"}`}>
          {Math.round(contextPercent)}%
        </span>
      </div>
    </div>
  );
}

