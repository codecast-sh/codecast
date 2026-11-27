import { useState } from "react";
import Link from "next/link";
import { Target, User } from "lucide-react";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import { badgeVariants } from "../ui/badge";
import { HoverCard } from "../ui/HoverCard";
import { TeamIcon } from "../TeamIcon";
import { PriorityCard, PrioritySheet } from "../priorities/PriorityRef";
import { useCoarsePointer } from "../../hooks/useCoarsePointer";
import { useEntityResolution } from "../../lib/entityDisplay";
import { priorityHref } from "../../lib/priorities";
import { Mark } from "../Mark";
import { useInboxStore } from "../../store/inboxStore";
import { rankTitle, workspaceMarkOf, type PriorityRankLabel } from "../../store/priorityOrder";

/**
 * On a session card filed under one of the viewer's priorities: the target,
 * its rank and title ("◎ #2 Trusted evals", the title cut to fit), then that
 * workspace's icon when the priority is in another workspace than the active
 * one. It behaves as the `pri-N` pill does (priorities/PriorityRef): a mouse
 * hovers it for the priority's card and clicks through to its page; a finger
 * taps it for the same card as a sheet. The card's row is asked for only when
 * it opens, so a list of chips fetches nothing. `neutral`: grey, on a row that
 * asks nothing of the eye (Shipping, Sleeping); `workspaceMark` false leaves
 * the workspace's icon off (a Shipping row, whose own mark is a rocket a team
 * icon can be too), and its label still names the workspace.
 */
export function PriorityRankChip({ rank, neutral = false, workspaceMark = true }: { rank: NonNullable<PriorityRankLabel>; neutral?: boolean; workspaceMark?: boolean }) {
  const teams = useInboxStore((s) => (rank.workspace ? s.teams : null));
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = rank.workspace ? workspaceMarkOf(rank.workspace, teams, viewerId) : null;
  const touch = useCoarsePointer();
  const [sheet, setSheet] = useState(false);
  const chip = (
    <Link
      href={priorityHref(rank.shortId)}
      data-priority-chip={rank.shortId}
      aria-label={rankTitle(rank, mark)}
      onClick={(e) => {
        if (!touch || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        setSheet(true);
      }}
      className={`${badgeVariants({ variant: neutral ? "neutral" : "cyan" })} min-w-0 max-w-[14rem] gap-1 overflow-hidden no-underline hover:underline`}
    >
      <Mark id="inbox.priority_rank" quiet><Target className="size-3 shrink-0" aria-hidden /></Mark>
      <span className="shrink-0 tabular-nums">#{rank.rank}</span>
      {rank.title && <span className="min-w-0 truncate">{rank.title}</span>}
      {mark && workspaceMark && (
        <Mark id="inbox.priority_workspace" tinted quiet>
          {mark.personal
            ? <User className="size-3 shrink-0 text-sol-text-muted" aria-hidden />
            : <TeamIcon icon={mark.icon} color={neutral ? null : mark.color} className="size-3 shrink-0" />}
        </Mark>
      )}
    </Link>
  );
  // The card it sits on selects its session on a click; nothing in the chip,
  // its hover card or its sheet (portals, which bubble through React) does.
  // The data attributes sit on the outermost element: the compact card's
  // stylesheet keeps `[data-priority-rank]` on its one line.
  return (
    <span
      data-priority-rank={rank.rank}
      data-priority-workspace={rank.workspace ?? undefined}
      data-priority-neutral={neutral ? "" : undefined}
      // Gives way after the task chip (shrink 10) and the project chip (1000): the priority is what the row is for.
      className="inline-flex min-w-[4.5rem] shrink-[5]"
      onClick={(e) => e.stopPropagation()}
    >
      <HoverCard card={<ChipCard shortId={rank.shortId} />} className="w-80 overflow-hidden" triggerClassName="inline-flex min-w-0 max-w-full" disabled={touch}>
        {chip}
      </HoverCard>
      {touch && sheet && <ChipSheet shortId={rank.shortId} onClose={() => setSheet(false)} />}
    </span>
  );
}

/** The priority's row, asked for by its `pri-N` (lib/entityDisplay, which feeds priorities.show). */
function usePriorityRow(shortId: string): PriorityRow | null {
  return (useEntityResolution(shortId, "priority").entity as PriorityRow | null) ?? null;
}

function ChipCard({ shortId }: { shortId: string }) {
  const row = usePriorityRow(shortId);
  return row ? <PriorityCard row={row} /> : <div className="p-3 text-meta text-sol-text-dim">Loading {shortId}…</div>;
}

function ChipSheet({ shortId, onClose }: { shortId: string; onClose: () => void }) {
  const row = usePriorityRow(shortId);
  return row ? <PrioritySheet row={row} open onOpenChange={(open) => { if (!open) onClose(); }} /> : null;
}
