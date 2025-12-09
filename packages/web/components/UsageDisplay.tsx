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

export function UsageBadge({ usage }: { usage: UsageData }) {
  const CONTEXT_LIMIT = 200000;
  const contextPercent = (usage.contextSize / CONTEXT_LIMIT) * 100;
  const isWarning = contextPercent > 80;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 border text-xs font-mono ${
        isWarning
          ? "text-red-400 border-red-500/40"
          : "text-sol-text-muted0 border-sol-border/40"
      }`}
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
        />
      </svg>
      {formatNumber(usage.contextSize)} ({Math.round(contextPercent)}%)
    </span>
  );
}
