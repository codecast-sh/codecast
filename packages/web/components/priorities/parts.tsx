// The small pieces every priority draws: the ten-day strip, and a milestone's
// state mark in the session language (components/inbox/SessionStatusMark).
// Only two marks are actions, and only they are bordered: Needs you (yellow,
// as the sidebar files it) opens the session to answer, and New session (the
// New session button's pen, filled primary) opens the composer seeded with
// the milestone's brief.
import type { ReactNode } from "react";
import Link from "next/link";
import { Rocket, SquarePen } from "lucide-react";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import type { MilestoneStateKind } from "@codecast/shared/contracts/priorityDerive";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { Mark } from "../Mark";
import { Button } from "../ui/button";
import { HoverCard } from "../ui/HoverCard";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { lookup } from "../../lib/liveEntities";
import { milestoneStartHref } from "../../lib/priorities";
import { dayDate } from "../../lib/priorityBreakdown";
import { deployPillState } from "../../lib/deploys/deployPill";
import { deployMarkId } from "../../lib/marks/work";
import { MILESTONE_STATE_WORD, TOUCH_AREA, type MilestoneModel } from "../../lib/priorityList";
import type { SessionStatus } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { useTrackedStore } from "../../store/inboxStore";
import { stableRefId } from "../../store/wakeSig";

const stop = (e: React.MouseEvent) => e.stopPropagation();
const NO_TASKS: string[] = [];

/**
 * On a coarse pointer a whole strip is one tap target: at least 44px tall,
 * across the strip's width, laid over its bars (so they never move), opening
 * one card for all its days. A fine pointer never sees it and keeps each
 * day's own hover card. Its parent is the strip, positioned.
 */
export function StripTap({ label, card }: { label: string; card: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-strip-tap
          aria-label={label}
          className="absolute inset-x-0 top-1/2 z-10 hidden h-full min-h-11 -translate-y-1/2 rounded-control [@media(pointer:coarse)]:block"
        />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" collisionPadding={8} className="w-auto max-w-[calc(100vw-16px)] p-0" data-strip-card>
        {card}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Ten days as bars on the page's one scale (`peak`), shaded by how much was
 * typed, today outlined. Hovering a day opens its card: the date and the
 * messages. A list row's bars are 20px (7px on a narrow list), the day
 * columns "Where your messages went" draws under the list; `page` spreads
 * them across the page with a date under each. On a touch screen the strip
 * is one tap target listing all ten days (StripTap). `pending`: the typing has not
 * arrived, so every day is its empty baseline and no day opens a card (it
 * would say 0 messages).
 */
export function DayStrip({ counts, days, todayIndex, peak, page, pending }: { counts: number[]; days: readonly string[]; todayIndex: number; peak: number; page?: boolean; pending?: boolean }) {
  const max = page ? 56 : 24;
  const top = Math.max(1, peak);
  const column = cn("flex flex-col items-center justify-end", page ? "min-w-0 flex-1" : "w-[20px] [@container(max-width:40rem)]:w-[7px]");
  const strip = (
    <span data-day-strip data-pending={pending || undefined} className={cn("relative flex items-end", page ? "w-full gap-1.5" : "gap-1 [@container(max-width:40rem)]:gap-[2px]")}>
      {!pending && (
        <StripTap
          label="Messages typed, last ten days"
          card={
            <ul className="px-3 py-2 text-ui">
              {counts.map((c, i) => (
                <li key={days[i]} data-strip-day={days[i]} className="flex items-baseline justify-between gap-6 py-0.5">
                  <span className={i === todayIndex ? "font-semibold text-sol-text" : "text-sol-text-muted"}>{dayDate(days[i])}</span>
                  <span className="tabular-nums text-sol-text">{c} {c === 1 ? "message" : "messages"}</span>
                </li>
              ))}
            </ul>
          }
        />
      )}
      {counts.map((n, i) => {
        const c = pending ? 0 : n;
        const share = Math.sqrt(Math.min(c, top) / top);
        const h = c <= 0 ? 2 : Math.max(5, Math.round(share * max));
        const today = i === todayIndex;
        const date = dayDate(days[i]);
        const day = (
          <>
            {/* Focusable by a tap (never a Tab stop), so a touch screen opens the day's card. */}
            <span data-day={days[i]} data-count={pending ? undefined : c} tabIndex={pending ? undefined : -1} className="flex w-full flex-col justify-end outline-none" style={{ height: max + 2 }}>
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
          </>
        );
        if (pending) return <span key={days[i]} className={column}>{day}</span>;
        return (
          <HoverCard
            key={days[i]}
            side="bottom"
            align="center"
            className="w-auto"
            triggerClassName={column}
            focusable
            card={
              <div data-day-card className="flex items-baseline gap-3 whitespace-nowrap px-2.5 py-1.5 text-ui">
                <span className="font-semibold text-sol-text">{date}</span>
                <span className="tabular-nums text-sol-text-muted">{c} {c === 1 ? "message" : "messages"}</span>
              </div>
            }
          >
            {day}
          </HoverCard>
        );
      })}
    </span>
  );
  // The strip is a registered mark (quiet: each day has its own card), so the legend lists it; a pending one draws no data yet.
  return pending ? strip : <Mark id="priority.ten_days" quiet className={page ? "w-full" : undefined}>{strip}</Mark>;
}

/** The session language's mark for each state a milestone can show without being an action. */
const QUIET_MARK: Record<"working" | "dormant" | "idle" | "done", SessionStatus> = { working: "working", dormant: "dormant", idle: "idle", done: "done" };

/** The 24px box a state mark sits in, the milestone line's first column. */
const BOX = "flex size-6 shrink-0 items-center justify-center";

/**
 * The bordered yellow Needs you mark: the same meaning as a session's Needs
 * you (session.needs_you), drawn as the milestone's action. `href`: the
 * session to answer; without one it is the mark alone.
 */
export function NeedsYouMark({ href, label }: { href?: string; label?: string }) {
  // The mark is the box alone, never the link around it, so every milestone's is one glyph in the legend.
  const box = (
    <Mark id="session.needs_you">
      <span className={cn(BOX, "rounded-control border border-sol-yellow/70 bg-sol-yellow/15 shadow-sm group-hover/needs:bg-sol-yellow/25")}>
        {/* The glyph inside is named by the box around it. */}
        <SessionStatusMark status="needs_you" size={13} quiet />
      </span>
    </Mark>
  );
  if (!href) return box;
  return <Link href={href} onClick={stop} data-state-action="needs_you" aria-label={label} className={cn("group/needs flex rounded-control outline-none focus-visible:ring-2 focus-visible:ring-sol-text-dim/60", TOUCH_AREA)}>{box}</Link>;
}

/**
 * A deploy in an open milestone's list, each state its own shape so a
 * grayscale screen tells them apart: live a green rocket, failed the
 * sessions' red error mark, still on its way a dashed grey rocket. Named as a
 * deploy pill names its state (deploy.*). `labeled`: its state's word sits
 * beside it.
 */
export function DeployMark({ status, labeled }: { status: string; labeled?: boolean }) {
  const id = deployMarkId(deployPillState({ status } as Parameters<typeof deployPillState>[0]));
  if (status === "failed") return <span data-deploy-mark="failed" className="flex"><SessionStatusMark status="error" size={13} markId={id} labeled={labeled} /></span>;
  return (
    <Mark id={id} labeled={labeled}>
      {status === "live"
        ? <Rocket data-deploy-mark="live" className="size-3.5 text-sol-green" aria-hidden />
        : <Rocket data-deploy-mark="pending" strokeDasharray="3 2" className="size-3.5 text-sol-text-dim" aria-hidden />}
    </Mark>
  );
}

/** A task whose row has not loaded has no status to draw: a neutral dot, never Open. */
export function UnknownTaskMark() {
  return <Mark id="priority.task_loading"><span data-task-status="unknown" aria-hidden className="block size-1.5 rounded-full bg-sol-text-dim/50" /></Mark>;
}

/** The filled primary pen, the New session button's icon, opening the composer at `href`. The mark is the button's face, not the link, so every milestone's is one glyph in the legend. */
export function NewSessionMark({ href }: { href: string }) {
  return (
    <Link href={href} onClick={stop} data-state-action="start" aria-label="New session on this milestone" className={cn("group/start flex shrink-0 rounded-control outline-none focus-visible:ring-2 focus-visible:ring-sol-text-dim/60", TOUCH_AREA)}>
      <Mark id="priority.new_session">
        <Button asChild variant="primary" size="icon-sm" className="size-6 shrink-0">
          <span><SquarePen aria-hidden /></span>
        </Button>
      </Mark>
    </Link>
  );
}

/** A quiet state as its mark alone: working, sleeping, idle, done. */
function QuietMark({ kind }: { kind: keyof typeof QUIET_MARK }) {
  return (
    <span data-state={kind} role="img" aria-label={MILESTONE_STATE_WORD[kind]} className={BOX}>
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
