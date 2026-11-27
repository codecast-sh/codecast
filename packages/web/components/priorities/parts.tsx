// The small pieces every priority draws: the ten-day strip, and a milestone's
// state mark in the session language (components/inbox/SessionStatusMark).
// Only two marks are actions, and only they are bordered: Needs you (yellow,
// as the sidebar files it) opens the session to answer, and New session (the
// New session button's pen, filled primary) opens the composer seeded with
// the milestone's brief.
import Link from "next/link";
import { SquarePen } from "lucide-react";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import type { MilestoneStateKind } from "@codecast/shared/contracts/priorityDerive";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Button } from "../ui/button";
import { HoverCard } from "../ui/HoverCard";
import { lookup } from "../../lib/liveEntities";
import { milestoneStartHref } from "../../lib/priorities";
import { dayDate } from "../../lib/priorityBreakdown";
import { MILESTONE_STATE_WORD, TOUCH_AREA, type MilestoneModel } from "../../lib/priorityList";
import type { SessionStatus } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { useTrackedStore } from "../../store/inboxStore";
import { stableRefId } from "../../store/wakeSig";

const stop = (e: React.MouseEvent) => e.stopPropagation();
const NO_TASKS: string[] = [];

/**
 * Ten days as bars on the page's one scale (`peak`), shaded by how much was
 * typed, today outlined. Hovering a day opens its card: the date and the
 * messages. A list row's bars are 20px (7px on a narrow list), the day
 * columns "Where your messages went" draws under the list; `page` spreads
 * them across the page with a date under each.
 */
export function DayStrip({ counts, days, todayIndex, peak, page }: { counts: number[]; days: readonly string[]; todayIndex: number; peak: number; page?: boolean }) {
  const max = page ? 56 : 24;
  const top = Math.max(1, peak);
  return (
    <span data-day-strip className={cn("flex items-end", page ? "w-full gap-1.5" : "gap-1 [@container(max-width:40rem)]:gap-[2px]")}>
      {counts.map((c, i) => {
        const share = Math.sqrt(Math.min(c, top) / top);
        const h = c <= 0 ? 2 : Math.max(5, Math.round(share * max));
        const today = i === todayIndex;
        const date = dayDate(days[i]);
        return (
          <HoverCard
            key={days[i]}
            side="bottom"
            align="center"
            className="w-auto"
            triggerClassName={cn("flex flex-col items-center justify-end", page ? "min-w-0 flex-1" : "w-[20px] [@container(max-width:40rem)]:w-[7px]")}
            card={
              <div data-day-card className="flex items-baseline gap-3 whitespace-nowrap px-2.5 py-1.5 text-ui">
                <span className="font-semibold text-sol-text">{date}</span>
                <span className="tabular-nums text-sol-text-muted">{c} {c === 1 ? "message" : "messages"}</span>
              </div>
            }
          >
            <span data-day={days[i]} data-count={c} className="flex w-full flex-col justify-end" style={{ height: max + 2 }}>
              <i
                className={cn("block w-full rounded-[2px]", today && "border border-sol-green/80", c > 0 ? "bg-sol-green" : "bg-sol-text/10")}
                style={{ height: h, opacity: c > 0 ? 0.45 + 0.55 * share : 1 }}
              />
            </span>
            {page && (
              <span data-day-label className={cn("mt-1 whitespace-nowrap text-mark tabular-nums", today ? "font-semibold text-sol-text" : "text-sol-text-dim")}>
                {/* A narrow page (a phone) has room for the day of the month alone. */}
                {today ? "Today" : <><span className="[@container(max-width:40rem)]:hidden">{date.replace(/^\w+,?\s*/, "")}</span><span className="hidden [@container(max-width:40rem)]:inline">{date.replace(/^.*\s/, "")}</span></>}
              </span>
            )}
          </HoverCard>
        );
      })}
    </span>
  );
}

/** The session language's mark for each state a milestone can show without being an action. */
const QUIET_MARK: Record<"working" | "dormant" | "idle" | "done", SessionStatus> = { working: "working", dormant: "dormant", idle: "idle", done: "done" };

/** The 24px box a state mark sits in, the milestone line's first column. */
const BOX = "flex size-6 shrink-0 items-center justify-center";

/** The bordered yellow Needs you mark. `href`: the session to answer; without one it is the mark alone (the legend). */
export function NeedsYouMark({ href, label }: { href?: string; label?: string }) {
  const look = cn(BOX, "rounded-control border border-sol-yellow/70 bg-sol-yellow/15 shadow-sm");
  if (!href) return <span className={look}><SessionStatusMark status="needs_you" size={13} /></span>;
  return (
    <Link href={href} onClick={stop} data-state-action="needs_you" title={label} aria-label={label} className={cn(look, TOUCH_AREA, "hover:bg-sol-yellow/25")}>
      <SessionStatusMark status="needs_you" size={13} />
    </Link>
  );
}

/** The filled primary pen, the New session button's icon. `href`: the composer to open; without one it is the mark alone (the legend). */
export function NewSessionMark({ href }: { href?: string }) {
  if (!href) return <Button asChild variant="primary" size="icon-sm" className="pointer-events-none size-6 shrink-0"><span><SquarePen aria-hidden /></span></Button>;
  return (
    <Button asChild variant="primary" size="icon-sm" className={cn("size-6 shrink-0", TOUCH_AREA)}>
      <Link href={href} onClick={stop} data-state-action="start" title="New session on this milestone" aria-label="New session on this milestone">
        <SquarePen aria-hidden />
      </Link>
    </Button>
  );
}

/** A quiet state as its mark alone: working, sleeping, idle, done. */
function QuietMark({ kind }: { kind: keyof typeof QUIET_MARK }) {
  return (
    <span data-state={kind} role="img" aria-label={MILESTONE_STATE_WORD[kind]} title={MILESTONE_STATE_WORD[kind]} className={BOX}>
      <SessionStatusMark status={QUIET_MARK[kind]} size={13} />
    </span>
  );
}

/** A milestone's state in its line's first column (lib/priorityList MilestoneModel.state). */
export function MilestoneStateMark({ row, m }: { row: Pick<PriorityRow, "short_id" | "plan">; m: Pick<MilestoneModel, "state" | "step" | "plan" | "tasks"> }) {
  const { kind, session } = m.state;
  if (kind === "needs_you") return <span data-state="needs_you" className="flex"><NeedsYouMark href={session?.href} label={`Needs you: ${session?.title || "open the session"}`} /></span>;
  if (kind === "start") return <span data-state="start" className="flex"><StartMark row={row} m={m} /></span>;
  // Nobody on it, and nothing to start (a past priority): no mark, the column kept.
  if (kind === "none") return <span data-state="none" className={BOX} />;
  return <QuietMark kind={kind} />;
}

/** New session on a milestone: the composer seeded with its brief, which names its open tasks by title from the store's task rows. */
function StartMark({ row, m }: { row: Pick<PriorityRow, "short_id" | "plan">; m: Pick<MilestoneModel, "step" | "plan" | "tasks"> }) {
  const taskIds = m.tasks.length ? m.tasks : NO_TASKS;
  // Read again whenever one of those tasks changes (a title, a close).
  const s = useTrackedStore([(st) => taskIds.map((id) => { const t = lookup(st.tasks, id); return t ? stableRefId(t) : 0; }).join(",")]);
  return <NewSessionMark href={milestoneStartHref(row, m, (id) => lookup(s.tasks, id))} />;
}
