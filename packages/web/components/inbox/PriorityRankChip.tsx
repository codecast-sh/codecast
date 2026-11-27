import { Target, User } from "lucide-react";
import { badgeVariants } from "../ui/badge";
import { TeamIcon } from "../TeamIcon";
import { Mark } from "../Mark";
import { useInboxStore } from "../../store/inboxStore";
import { rankTitle, workspaceMarkOf, type PriorityRankLabel } from "../../store/priorityOrder";

/** While the inbox is in its Priorities view: the priority target and the rank of the viewer's priority a card serves ("◎ 3"),
 *  followed by that workspace's icon when the priority is in another workspace than the active one. */
export function PriorityRankChip({ rank }: { rank: NonNullable<PriorityRankLabel> }) {
  const teams = useInboxStore((s) => (rank.workspace ? s.teams : null));
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = rank.workspace ? workspaceMarkOf(rank.workspace, teams, viewerId) : null;
  return (
    <span data-priority-rank={rank.rank} data-priority-workspace={rank.workspace ?? undefined} title={rankTitle(rank, mark)} className={`${badgeVariants({ variant: "cyan" })} shrink-0 gap-1 tabular-nums`}>
      <Mark id="inbox.priority_rank"><Target className="size-3 shrink-0" aria-hidden /></Mark>
      {rank.rank}
      {mark && (
        <Mark id="inbox.priority_workspace">
          {mark.personal
            ? <User className="size-3 shrink-0 text-sol-text-muted" aria-hidden />
            : <TeamIcon icon={mark.icon} color={mark.color} className="size-3 shrink-0" />}
        </Mark>
      )}
    </span>
  );
}
