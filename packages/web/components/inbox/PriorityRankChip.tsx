import { badgeVariants } from "../ui/badge";
import { rankLabelWords, type PriorityRankLabel } from "../../store/priorityOrder";

/** While the inbox is in its Priorities view: the rank of the viewer's priority a card serves ("#3"),
 *  "—" for a priority in another workspace (not loaded here; "other ws" on a touch screen), or "None". */
export function PriorityRankChip({ rank }: { rank: PriorityRankLabel }) {
  const ranked = typeof rank === "number";
  const look = badgeVariants({ variant: ranked ? "cyan" : "neutral" });
  const { text, touch, title } = rankLabelWords(rank);
  return (
    <span data-priority-rank={ranked ? rank : rank ?? "none"} title={title} className={`${look} shrink-0 tabular-nums ${ranked ? "" : "text-sol-text-dim"}`}>
      {text === touch ? text : <><span className="[@media(pointer:coarse)]:hidden">{text}</span><span className="hidden [@media(pointer:coarse)]:inline">{touch}</span></>}
    </span>
  );
}
