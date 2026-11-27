import { Target, User } from "lucide-react";
import { badgeVariants } from "../ui/badge";
import { TeamIcon } from "../TeamIcon";
import { useInboxStore } from "../../store/inboxStore";
import { rankTitle, workspaceMarkOf, type PriorityRankLabel } from "../../store/priorityOrder";

/** While the inbox is in its Priorities view: the priority target and the rank of the viewer's priority a card serves ("◎ 3"),
 *  followed by that workspace's icon when the priority is in another workspace than the active one. `neutral`: grey, on a row
 *  that asks nothing of the eye (Shipping, Sleeping); `workspaceMark` false leaves the icon off (its title still names the workspace). */
export function PriorityRankChip({ rank, neutral = false, workspaceMark = true }: { rank: NonNullable<PriorityRankLabel>; neutral?: boolean; workspaceMark?: boolean }) {
  const teams = useInboxStore((s) => (rank.workspace ? s.teams : null));
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = rank.workspace ? workspaceMarkOf(rank.workspace, teams, viewerId) : null;
  return (
    <span data-priority-rank={rank.rank} data-priority-workspace={rank.workspace ?? undefined} data-priority-neutral={neutral ? "" : undefined} title={rankTitle(rank, mark)} className={`${badgeVariants({ variant: neutral ? "neutral" : "cyan" })} shrink-0 gap-1 tabular-nums`}>
      <Target className="size-3 shrink-0" aria-hidden />
      {rank.rank}
      {mark && workspaceMark && (mark.personal
        ? <User className="size-3 shrink-0 text-sol-text-muted" aria-hidden />
        : <TeamIcon icon={mark.icon} color={neutral ? null : mark.color} className="size-3 shrink-0" />)}
    </span>
  );
}
