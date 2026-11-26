import type { ReactNode } from "react";
import { ModernSectionHeader } from "./ModernSectionHeader";
import { SessionStatusMark } from "./SessionStatusMark";

// The Modern head of a hidden bucket at the foot of the rail (Snoozed,
// Stashed, Closed: GlobalSessionPanel's renderHiddenBucket). It is the section
// head every other section wears, so the rail's marks and labels share one
// column; the bucket's live agents ride after the count.
export function HiddenBucketHead({ label, count, variant, expanded, onToggle, liveCount, action }: {
  label: string;
  count: number;
  variant: "stashed" | "dismissed" | "snoozed";
  expanded: boolean;
  onToggle: () => void;
  liveCount: number;
  action?: ReactNode;
}) {
  return (
    <ModernSectionHeader
      label={label}
      count={count}
      color="text-sol-text-dim"
      sectionKey={`hidden_${variant}`}
      collapsed={!expanded}
      onToggle={onToggle}
      icon={<SessionStatusMark status={variant === "dismissed" ? "killed" : variant === "stashed" ? "stashed" : "dormant"} />}
      facts={liveCount > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-mark tabular-nums text-sol-green">
          <SessionStatusMark status="working" size={8} />
          {liveCount} running
        </span>
      )}
      action={action}
      hideCount={count === 0}
    />
  );
}
