import type { ReactNode } from "react";
import { LivePulseDot } from "../SessionActivityLine";
import { ModernSectionHeader } from "./ModernSectionHeader";
import { SessionStatusMark } from "./SessionStatusMark";

// The head of a hidden bucket at the foot of the rail (Snoozed, Stashed,
// Closed: GlobalSessionPanel's renderHiddenBucket). Modern wears the section
// head every other section wears, so the rail's marks and labels share one
// column; the bucket's live agents ride after the count.
// `count` is what the bucket draws, as the live sections count
// (sectionHeaderCount): subagents folded under a card add none.
export function HiddenBucketHead({ modern, label, count, variant, expanded, onToggle, liveCount, action }: {
  modern: boolean;
  label: string;
  count: number;
  variant: "stashed" | "dismissed" | "snoozed";
  expanded: boolean;
  onToggle: () => void;
  liveCount: number;
  action?: ReactNode;
}) {
  if (modern) {
    return (
      <ModernSectionHeader
        label={label}
        count={count}
        color="text-sol-text-dim"
        sectionKey={`hidden_${variant}`}
        collapsed={!expanded}
        onToggle={onToggle}
        icon={<SessionStatusMark status={variant === "dismissed" ? "killed" : variant === "stashed" ? "stashed" : "dormant"} markId={variant === "snoozed" ? "inbox.snoozed" : undefined} labeled />}
        facts={liveCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-mark tabular-nums text-sol-green">
            <SessionStatusMark status="working" size={8} labeled />
            {liveCount} running
          </span>
        )}
        action={action}
        hideCount={count === 0}
      />
    );
  }
  return (
    <div data-sv-hidden-head className="w-full bg-sol-bg border-b border-sol-border/30 flex items-center">
      <button
        onClick={onToggle}
        className="flex-1 min-w-0 pl-3 py-1.5 flex items-center text-left"
      >
        <span data-sv-hidden-label className="text-mark font-semibold uppercase tracking-wider text-sol-text-dim">
          {label}{count > 0 ? ` (${count})` : null}
        </span>
        {liveCount > 0 && (
          <span className="ml-1.5 shrink-0 inline-flex items-center whitespace-nowrap gap-1 px-1.5 py-0 rounded-full text-meta font-semibold bg-sol-green/10 text-sol-green border border-sol-green/30 normal-case tracking-normal modern:h-5 modern:rounded-control modern:border-transparent modern:font-medium">
            <LivePulseDot still />
            {liveCount} running
          </span>
        )}
      </button>
      {action}
      <button onClick={onToggle} className="shrink-0 pl-2 pr-3 py-1.5">
        <svg className={`w-3 h-3 transition-transform text-sol-text-dim ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
}
