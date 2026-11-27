// One priority on /priorities: its rank, its title with the ⋯ right after it
// (on hover; always on touch), and its ten days of typing; then its open
// critical milestones, each with its state mark in the box column
// (components/priorities/parts), then DONE n and POLISH x/y. A milestone
// opens in place to everything it is connected to (Connected); its ⋯ holds
// Done/Undone and the rest of the owner's controls (controls), and a
// double-click on its title renames it. On a desktop list the owner's rank is
// a drag handle (arrow keys step it).
import { useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { milestoneHref, pastBadge, priorityHref, rankProvenance, type PriorityRow } from "../../lib/priorities";
import type { ListLayout, MilestoneModel, PriorityModel } from "../../lib/priorityList";
import { TOUCH_AREA } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { LinkLookups } from "../../hooks/usePriorityModels";
import { usePriorityWrites } from "../../hooks/usePriorities";
import { DayStrip, MilestoneStateMark } from "./parts";
import { Connected } from "./Connected";
import { LooksDone, MilestoneMenu, MilestoneTitleInput, PriorityMenu } from "./controls";

/** A desktop drag of the owner's rank (PrioritiesView): this row's part in it. */
export type RankDrag = {
  /** This row is the one being dragged. */
  dragging: boolean;
  /** A drag of one of this owner's other priorities is under way: this row takes a drop. */
  accepts: boolean;
  /** Where the dragged one would land against this row. */
  over: "before" | "after" | null;
  start: () => void;
  end: () => void;
  hover: (after: boolean) => void;
  drop: (after: boolean) => void;
};

const lowerHalf = (e: DragEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

const C_RANK = "text-right text-ui tabular-nums text-sol-text-dim";
/** A title on one line on a mouse; under a coarse pointer it wraps onto a second, since nothing there hovers for the rest. */
const COARSE_WRAP = "[@media(pointer:coarse)]:line-clamp-2 [@media(pointer:coarse)]:whitespace-normal";
const LABEL = "text-mark font-semibold uppercase tracking-wide tabular-nums text-sol-text-dim";

export function PriorityBlock({ model, layout, days, todayIndex, peak, typingPending, now, lookups, drag }: {
  model: PriorityModel;
  layout: ListLayout;
  days: readonly string[];
  todayIndex: number;
  /** The busiest day across every row: all strips share it. */
  peak: number;
  /** The typing per day has not arrived: the strip draws its baseline (DayStrip pending). */
  typingPending?: boolean;
  now: number;
  lookups: LinkLookups;
  /** Set on the owner's own active rows of a desktop list. */
  drag?: RankDrag;
}) {
  const { row } = model;
  const wide = layout === "wide";
  const past = row.status !== "active";
  // The row's own correction, when no milestone line carries it.
  const pending = row.correction_pending && !model.milestones.some((m) => m.correctionPending);
  const [renaming, setRenaming] = useState(false);
  return (
    <li
      data-priority={row.short_id}
      data-status={row.status}
      data-dragging={drag?.dragging || undefined}
      onDragOver={drag?.accepts ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; drag.hover(lowerHalf(e)); } : undefined}
      onDrop={drag?.accepts ? (e) => { e.preventDefault(); drag.drop(lowerHalf(e)); } : undefined}
      className={cn("relative border-b border-sol-border/50 pb-2 pt-3 last:border-b-0", drag?.dragging && "opacity-40")}
    >
      {drag?.over && <span aria-hidden data-drop-at={drag.over} className={cn("pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-sol-blue", drag.over === "before" ? "-top-px" : "-bottom-px")} />}
      <div data-priority-head className={cn("grid items-center gap-x-2", wide ? "grid-cols-[20px_minmax(0,1fr)_auto]" : "grid-cols-[16px_minmax(0,1fr)_auto]")}>
        <Rank row={row} drag={drag} />
        <span className="group/head flex min-w-0 items-center gap-1">
          {renaming ? (
            <PriorityTitleInput row={row} onDone={() => setRenaming(false)} className={wide ? "font-semibold sm:text-body" : "font-semibold"} />
          ) : (
            <PriorityTitleLink
              row={row}
              onRename={() => setRenaming(true)}
              // Under a coarse pointer 13px above and below an 18px line make it a 44px target, and never less.
              className={cn("min-w-0 font-semibold text-sol-text decoration-sol-text-dim/50 hover:underline [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-[13px]", wide ? cn("truncate text-body", COARSE_WRAP) : "line-clamp-2 text-ui", past && "text-sol-text-muted")}
            />
          )}
          {!renaming && <PriorityMenu row={row} reveal="group-hover/head:opacity-100" onRename={() => setRenaming(true)} />}
          {past && <span data-past className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>}
          {pending && <PendingMark />}
        </span>
        <DayStrip counts={model.counts} days={days} todayIndex={todayIndex} peak={peak} pending={typingPending} />
      </div>
      <div className={wide ? "ml-[28px] mt-1" : "ml-[24px] mt-1"}>
        <Milestones model={model} layout={layout} now={now} lookups={lookups} olderHref={(key) => milestoneHref(row.short_id, key)} />
      </div>
    </li>
  );
}

/**
 * The rank, with who placed it on hover ("ranked by AI" or "you placed it";
 * the row's ⋯ says it too, for a finger). On the owner's desktop list it is a
 * drag handle, and the arrow keys step it.
 */
function Rank({ row, drag }: { row: PriorityRow; drag?: RankDrag }) {
  const writes = usePriorityWrites();
  // A step down moves this row's <li> in the DOM, and Chrome drops the focus of an element moved that way: put it back once the move paints.
  const stepped = useRef(false);
  useLayoutEffect(() => {
    if (!stepped.current) return;
    stepped.current = false;
    document.querySelector<HTMLElement>(`[data-rank-handle="${row.short_id}"]`)?.focus();
  }, [row.rank, row.short_id]);
  const why = rankProvenance(row);
  const said = row.rank == null ? undefined : `#${row.rank}${why ? ` · ${why}` : ""}`;
  if (!drag || row.rank == null) return <span className={C_RANK} title={said} data-rank-source={row.rank == null ? undefined : row.rank_source}>{row.rank ?? ""}</span>;
  return (
    <button
      type="button"
      draggable
      data-rank-handle={row.short_id}
      data-rank-source={row.rank_source}
      title={`${said}. Drag to move, or use the arrow keys.`}
      aria-label={`Rank ${row.rank}, ${why}: drag to move, or use the arrow keys`}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", row.short_id); drag.start(); }}
      onDragEnd={drag.end}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        stepped.current = true;
        writes.move(row.short_id, e.key === "ArrowUp" ? "up" : "down");
        // At either end nothing moves: the flag must not linger for some later change of rank.
        requestAnimationFrame(() => { stepped.current = false; });
      }}
      className={cn(C_RANK, TOUCH_AREA, "-mx-1 cursor-grab rounded px-1 hover:bg-sol-bg-alt hover:text-sol-text active:cursor-grabbing")}
    >
      {row.rank}
    </button>
  );
}

/** A second click inside this long cancels the first's navigation: the pair is a double-click (a slow one too; macOS allows ~500ms). */
const DOUBLE_CLICK_MS = 400;

/**
 * The priority's title on the list: a real link to its page, which the owner
 * also double-clicks to rename. So the owner's plain click waits
 * DOUBLE_CLICK_MS before it navigates, and a second click inside that cancels
 * it. A modified or middle click, a keyboard Enter (a click with no
 * pointer count) and a tap (touch renames through the ⋯) navigate at once,
 * as any link does. The deferred navigation re-clicks the link, so it routes
 * as every link click does.
 */
function PriorityTitleLink({ row, onRename, className }: { row: PriorityRow; onRename: () => void; className: string }) {
  const pendingNav = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The deferred click, let through to the link's own navigation.
  const passing = useRef(false);
  // The pointer that pressed it: a click event does not say so everywhere.
  const pointer = useRef<string | null>(null);
  const cancel = () => {
    if (pendingNav.current) clearTimeout(pendingNav.current);
    pendingNav.current = null;
  };
  useMountEffect(() => cancel);
  return (
    <Link
      href={priorityHref(row.short_id)}
      data-priority-title
      title={row.title}
      onClick={row.mine ? (e) => {
        if (passing.current) { passing.current = false; return; }
        const touch = ((e.nativeEvent as PointerEvent).pointerType || pointer.current) === "touch";
        if (touch || e.detail === 0 || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        cancel();
        if (e.detail > 1) return;
        const link = e.currentTarget;
        pendingNav.current = setTimeout(() => {
          pendingNav.current = null;
          passing.current = true;
          link.click();
          passing.current = false;
        }, DOUBLE_CLICK_MS);
      } : undefined}
      onPointerDown={row.mine ? (e) => { pointer.current = e.pointerType; } : undefined}
      onDoubleClick={row.mine ? (e) => { e.preventDefault(); cancel(); onRename(); } : undefined}
      className={className}
    >
      {row.title}
    </Link>
  );
}

/** The priority's title being renamed in place, on the list and on its page: Enter or leaving saves, Escape takes it back. */
export function PriorityTitleInput({ row, onDone, className }: { row: Pick<PriorityRow, "short_id" | "title">; onDone: () => void; className?: string }) {
  const writes = usePriorityWrites();
  return (
    <MilestoneTitleInput
      title={row.title}
      label="Priority title"
      className={className}
      onDone={(next) => { onDone(); if (next) writes.renamePriority(row.short_id, next); }}
    />
  );
}

/** "correction pending": the person's correction waits for the next pass. */
function PendingMark() {
  return <span data-correction-pending title="Your correction waits for the next pass" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-mark text-sol-text-dim"><i aria-hidden className="block size-[5px] rounded-full border border-sol-text-dim" />correction pending</span>;
}

/** A section's head: DONE 4 or POLISH 0/2, the number after the word, its caret beside it. */
function SectionHead({ kind, label, count, open, onClick }: { kind: string; label: string; count: string; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-section={kind}
      aria-expanded={open}
      onClick={onClick}
      className={cn("-ml-1 inline-flex min-h-6 items-center gap-1 rounded px-1 hover:bg-sol-bg-alt hover:text-sol-text [@media(pointer:coarse)]:min-h-11", LABEL)}
    >
      {label} <span className="font-normal">{count}</span>
      <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
    </button>
  );
}

type Section = { kind: string; head: ReactNode; open: boolean; rows: MilestoneModel[] };

/**
 * A priority's milestones: the open critical ones, then Done and Polish. A
 * closed section is its head, sharing one line with the next closed one; an
 * open one is its head, caret and all, over its milestones. `expand` opens
 * every open milestone (the priority's page); `focus` opens the one a link
 * named, and the section that holds it.
 */
export function Milestones({ model, layout, now, lookups, olderHref, expand, focus }: {
  model: PriorityModel;
  layout: ListLayout;
  now: number;
  lookups: LinkLookups;
  olderHref?: (key: string) => string;
  expand?: boolean;
  focus?: string | null;
}) {
  const critical = model.milestones.filter((m) => m.tier === "critical");
  const polish = model.milestones.filter((m) => m.tier === "polish");
  const done = critical.filter((m) => m.done);
  const [doneOpen, setDoneOpen] = useState(() => done.some((m) => m.key === focus));
  const [polishOpen, setPolishOpen] = useState(() => polish.some((m) => m.key === focus));
  const line = (m: MilestoneModel) => <MilestoneRow key={m.key} model={model} m={m} layout={layout} now={now} lookups={lookups} olderHref={olderHref?.(m.key)} defaultOpen={(expand && !m.done) || m.key === focus} />;
  const sections: Section[] = [];
  if (done.length) sections.push({ kind: "done", open: doneOpen, rows: done, head: <SectionHead key="done" kind="done" label="Done" count={`${done.length}`} open={doneOpen} onClick={() => setDoneOpen((o) => !o)} /> });
  if (polish.length) sections.push({ kind: "polish", open: polishOpen, rows: polish, head: <SectionHead key="polish" kind="polish" label="Polish" count={`${polish.filter((m) => m.done).length}/${polish.length}`} open={polishOpen} onClick={() => setPolishOpen((o) => !o)} /> });
  // In order: consecutive closed sections share one line; an open one is its head over its milestones.
  const runs: Section[][] = [];
  for (const x of sections) {
    const last = runs[runs.length - 1];
    if (!x.open && last && !last[0].open) last.push(x);
    else runs.push([x]);
  }
  return (
    <>
      <ul>{critical.filter((m) => !m.done).map(line)}</ul>
      {runs.map((run) => (run[0].open ? (
        <div key={run[0].kind} data-section-open={run[0].kind} className="mt-0.5">
          <div className="pl-8">{run[0].head}</div>
          <ul>{run[0].rows.map(line)}</ul>
        </div>
      ) : (
        <div key={run[0].kind} className="mt-0.5 flex flex-wrap items-center gap-x-5 pl-8">{run.map((x) => x.head)}</div>
      )))}
    </>
  );
}

function MilestoneRow({ model, m, layout, now, lookups, olderHref, defaultOpen = false }: {
  model: PriorityModel;
  m: MilestoneModel;
  layout: ListLayout;
  now: number;
  lookups: LinkLookups;
  olderHref?: string;
  defaultOpen?: boolean;
}) {
  const { row } = model;
  const { step } = m;
  const wide = layout === "wide";
  const writes = usePriorityWrites();
  const [open, setOpen] = useState(defaultOpen);
  const [renaming, setRenaming] = useState(false);
  const toggle = () => setOpen((o) => !o);
  return (
    <li data-milestone={m.key} data-state={m.state.kind}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) toggle(); }}
        className={cn(
          "group/line -mx-1.5 flex cursor-pointer items-center gap-2 rounded-control px-1.5 hover:bg-sol-bg-alt/60",
          wide ? "min-h-8 [@media(pointer:coarse)]:min-h-11" : "min-h-11 py-0.5",
          open && "bg-sol-bg-alt/60",
        )}
      >
        <MilestoneStateMark row={row} m={m} />
        {/* A phone keeps the title's width: its marks go on a line of their own under it. */}
        <span className={cn("flex min-w-0 flex-1", wide ? "items-center gap-2" : "flex-col items-start")}>
          <span className={cn("flex min-w-0 items-center gap-1", renaming && "w-full")}>
            {renaming ? (
              <MilestoneTitleInput title={step.title} onDone={(next) => { setRenaming(false); if (next) writes.renameStep(row.short_id, step.key, next); }} />
            ) : (
              <span
                data-milestone-title
                title={step.title}
                onDoubleClick={row.mine ? (e) => { e.stopPropagation(); setRenaming(true); } : undefined}
                className={cn(
                  "min-w-0 text-ui",
                  open ? "whitespace-normal break-words" : wide ? cn("truncate", COARSE_WRAP) : "line-clamp-2",
                  step.done ? "text-sol-text-dim" : m.tier === "polish" ? "text-sol-text-muted" : "text-sol-text",
                )}
              >
                {step.title}
              </span>
            )}
            {row.mine && !renaming && <MilestoneMenu row={row} step={step} onRename={() => setRenaming(true)} reveal="group-hover/line:opacity-100" />}
          </span>
          {(m.looksDone || m.correctionPending) && (
            <span data-milestone-marks className="flex shrink-0 items-center gap-2">
              {m.looksDone && <LooksDone row={row} step={step} />}
              {m.correctionPending && <PendingMark />}
            </span>
          )}
        </span>
        <ChevronRight aria-hidden data-line-chevron className={cn("size-3.5 shrink-0 text-sol-text-dim opacity-0 transition group-hover/line:opacity-100", open && "rotate-90 opacity-100")} />
      </div>
      {open && <Connected model={model} m={m} now={now} lookups={lookups} olderHref={olderHref} />}
    </li>
  );
}
