import { badgeVariants } from "../ui/badge";

/** The rank of the viewer's priority a card serves ("#3"), or "None", while the inbox is in its Priorities view. */
export function PriorityRankChip({ rank }: { rank: number | null }) {
  const look = badgeVariants({ variant: rank == null ? "neutral" : "cyan" });
  return (
    <span
      data-priority-rank={rank ?? "none"}
      title={rank == null ? "Serves none of your priorities" : `Your priority #${rank}`}
      className={`${look} shrink-0 tabular-nums ${rank == null ? "text-sol-text-dim" : ""}`}
    >
      {rank == null ? "None" : `#${rank}`}
    </span>
  );
}
