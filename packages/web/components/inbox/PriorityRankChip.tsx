import { badgeVariants } from "../ui/badge";
import { PRIORITY_ELSEWHERE, type PriorityRankLabel } from "../../store/priorityOrder";

/** While the inbox is in its Priorities view: the rank of the viewer's priority a card serves ("#3"),
 *  "—" for a priority in another workspace (not loaded here), or "None". */
export function PriorityRankChip({ rank }: { rank: PriorityRankLabel }) {
  const ranked = typeof rank === "number";
  const look = badgeVariants({ variant: ranked ? "cyan" : "neutral" });
  const [text, title] = ranked
    ? [`#${rank}`, `Your priority #${rank}`]
    : rank === PRIORITY_ELSEWHERE
      ? ["—", "In another workspace"]
      : ["None", "Serves none of your priorities"];
  return (
    <span data-priority-rank={ranked ? rank : rank ?? "none"} title={title} className={`${look} shrink-0 tabular-nums ${ranked ? "" : "text-sol-text-dim"}`}>
      {text}
    </span>
  );
}
