// One priority on /priorities. A header on the page's fixed grid (rank,
// title, progress with its polish link, today's messages, momentum, menu),
// the plan on a meta line when it has one, then one line per open critical
// milestone: its box, its title and, in the action column, the priority's
// one action on the line it belongs to, an outlined Answer for any other
// session that asks, else one quiet session chip. A session working most of
// the open critical milestones heads a bracket down the action column over
// the lines it covers. A line opens into its sessions (people's first,
// workflow runs folded) and the links the Show filter asks for. In the
// compact view a priority is its header alone, its action inside it. The
// owner's controls (components/priorities/controls): the row's ⋯, each
// milestone's ⋯ and its box as a Done toggle across the line's left gutter,
// each session's ⋯ in an open milestone, and on a desktop list the rank as a
// drag handle (arrow keys step it).
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { PriorityPlanRef } from "@codecast/shared/contracts/priorities";
import { asksPerson, bestSession, isClosedSession } from "@codecast/shared/contracts/priorityDerive";
import { milestoneHref, pastBadge, rankProvenance, type PriorityRow } from "../../lib/priorities";
import { COARSE_TALL, LINE_LABEL_MAX, LINE_PLAN_TITLE_MIN, LIST_GRID, POLISH_SLOT, STATE_WORD, TOUCH_AREA, ago, fitLine, lineSession, runKinds, type ListFilters, type ListLayout, type MilestoneModel, type PriorityModel, type SessionLine } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { branchesOf, type LinkLookups } from "../../hooks/usePriorityModels";
import { usePriorityWrites } from "../../hooks/usePriorities";
import type { LinkKind } from "./parts";
import { Mark } from "../Mark";
import { ActionButton, AnswerSecondary, BranchChip, DayStrip, DeployChip, InSession, KindCount, MilestoneMark, PlanChip, PrChip, SessionChip, SessionSlot, TaskChip } from "./parts";
import { LooksDone, MilestoneMenu, MilestoneTitleInput, MilestoneToggle, PriorityMenu, SessionMenu } from "./controls";

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

const C_RANK = "col-start-1 row-start-1 text-right text-ui font-semibold tabular-nums text-sol-text-dim";
const C_TITLE = "col-start-2 row-start-1 min-w-0";
const C_PROGRESS = "col-start-3 row-start-1 justify-self-end";
const C_META = "col-start-2 col-end-6 row-start-2 min-w-0";
/** A wide row's ⋯: outside the grid, in the page's right gutter, level with the row's first line. It ends 32px past the grid,
 *  inside the narrowest gutter (Classic's 32px), and its touch press area grows only leftward (controls `gutter`). */
const C_MENU = "absolute left-full top-0 ml-2 flex h-5 items-center";
/** A milestone line's ⋯, at the same x: the line's own box already reaches 6px into the gutter. Centred on the line's first row:
 *  32px on a mouse, 48px under a coarse pointer, where the 44px press area then fits inside the line's clip. */
const C_LINE_MENU = "absolute left-full top-1 ml-0.5 flex [@media(pointer:coarse)]:top-3";
const C_MENU_PHONE = "col-start-5 row-start-1 justify-self-end";
/** A wide row's title, one line on a mouse; under a coarse pointer it wraps onto a second, since nothing there hovers for the rest. */
const COARSE_WRAP = "[@media(pointer:coarse)]:line-clamp-2 [@media(pointer:coarse)]:whitespace-normal";

export function PriorityBlock({ model, layout, compact, filters, todayIndex, peak, now, lookups, drag }: {
  model: PriorityModel;
  layout: ListLayout;
  compact: boolean;
  filters: ListFilters;
  todayIndex: number;
  /** The busiest day across every row: all momentum strips share it. */
  peak: number;
  now: number;
  lookups: LinkLookups;
  /** Set on the owner's own active rows of a desktop list. */
  drag?: RankDrag;
}) {
  const { row } = model;
  const [doneOpen, setDoneOpen] = useState(!filters.hideDone);
  const [polishOpen, setPolishOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const past = row.status !== "active";
  const critical = model.milestones.filter((m) => m.tier === "critical");
  const polish = model.milestones.filter((m) => m.tier === "polish");
  const wide = layout === "wide";
  const rail = filters.show.sessions && wide ? model.rail : null;
  // Collapsed polish still shows the line holding the priority's action and any line asking the person: nothing waiting is out of sight.
  const polishShown = polish.filter((m) => polishOpen ? !m.done || doneOpen : model.action?.milestone.key === m.key || m.sessions.some(asksPerson));

  const line = (m: MilestoneModel) => (
    <MilestoneLine
      key={m.key}
      model={model}
      m={m}
      layout={layout}
      filters={filters}
      rail={rail && rail.keys.includes(m.key) ? railPart(rail.keys, m.key) : null}
      open={openKey === m.key}
      onToggle={() => setOpenKey((k) => (k === m.key ? null : m.key))}
      now={now}
      lookups={lookups}
    />
  );
  return (
    <li
      data-priority={row.short_id}
      data-status={row.status}
      data-dragging={drag?.dragging || undefined}
      onDragOver={drag?.accepts ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; drag.hover(lowerHalf(e)); } : undefined}
      onDrop={drag?.accepts ? (e) => { e.preventDefault(); drag.drop(lowerHalf(e)); } : undefined}
      className={cn("relative border-b border-sol-border/50 pb-1.5 pt-2 last:border-b-0", past && "opacity-70", drag?.dragging && "opacity-40")}
    >
      {drag?.over && <span aria-hidden data-drop-at={drag.over} className={cn("pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-sol-blue", drag.over === "before" ? "-top-px" : "-bottom-px")} />}
      <PriorityHeader
        model={model}
        layout={layout}
        compact={compact}
        filters={filters}
        todayIndex={todayIndex}
        peak={peak}
        drag={drag}
        polish={polish.length ? { done: polish.filter((m) => m.done).length, total: polish.length, open: polishOpen, toggle: () => setPolishOpen((o) => !o) } : null}
        onProgress={critical.some((m) => m.done) ? () => setDoneOpen((o) => !o) : undefined}
      />
      {!compact && (
        <ul>
          {critical.filter((m) => !m.done).map(line)}
          {doneOpen && critical.filter((m) => m.done).map(line)}
          {polishShown.length > 0 && (
            <>
              <li aria-hidden className="ml-[26px] mt-0.5 flex items-center gap-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">
                Polish <span className="h-px flex-1 bg-sol-border/50" />
              </li>
              {polishShown.map(line)}
            </>
          )}
        </ul>
      )}
    </li>
  );
}

type RailPart = "head" | "mid" | "end";
const railPart = (keys: string[], key: string): RailPart => (key === keys[0] ? "head" : key === keys[keys.length - 1] ? "end" : "mid");

/** Where a priority stands: its critical pips and count (a press shows the done ones), or why it is past. */
function Progress({ model, layout, onToggle }: { model: PriorityModel; layout: ListLayout; onToggle?: () => void }) {
  const { row } = model;
  const { critical_done: d, critical_total: t } = row.counts;
  if (row.status !== "active") return <span className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>;
  if (t === 0) return null;
  const body = (
    <>
      {layout === "wide" && (
        <Mark id="priority.critical">
          <span className="flex gap-[2px]">
            {Array.from({ length: t }, (_, i) => <i key={i} className={cn("block h-[7px] w-[7px] rounded-[1.5px]", i < d ? "bg-sol-green" : "bg-sol-text/15")} />)}
          </span>
        </Mark>
      )}
      <span data-progress className="text-meta tabular-nums text-sol-text-muted">{d}/{t}</span>
    </>
  );
  return onToggle
    ? <button type="button" data-progress-toggle onClick={onToggle} title={`${d} of ${t} critical milestones done: show them`} className={cn("flex items-center gap-1.5 rounded px-1 hover:bg-sol-bg-alt", TOUCH_AREA)}>{body}</button>
    : <span className="flex items-center gap-1.5 px-1">{body}</span>;
}

/** Stalled, in words and a diamond so it reads without colour. */
function StalledMark({ days, className }: { days: number; className?: string }) {
  return <span data-stalled className={cn("shrink-0 items-center gap-1 whitespace-nowrap text-mark font-semibold text-sol-text", className)}><Mark id="priority.stalled" labeled><i aria-hidden className="block size-[6px] rotate-45 border border-sol-text" /></Mark>Stalled {days}d</span>;
}

/** Stalled as its mark alone, beside the strip of a compact row that has no room for the words. */
function StalledIcon({ days, className }: { days: number; className?: string }) {
  return (
    <span data-stalled role="img" aria-label={`Stalled ${days}d`} className={cn("size-3 shrink-0 items-center justify-center", className)}>
      <Mark id="priority.stalled"><i aria-hidden className="block size-[6px] rotate-45 border border-sol-text" /></Mark>
    </span>
  );
}

/** "correction pending": the person's correction waits for the next pass. */
export function PendingMark() {
  return <span data-correction-pending title="Your correction waits for the next pass" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-mark text-sol-text-dim"><i aria-hidden className="block size-[5px] rounded-full border border-sol-text-dim" />correction pending</span>;
}

/** How long since a critical milestone last landed, in words. */
const lastLanded = (days: number | null) => (days == null ? "none yet" : days === 0 ? "last today" : `last ${days}d`);

/** "N landed · last Nd", where the momentum column has no room for words beside its strip: under it, on the row's meta line. */
function MomentumWords({ model, stalled, className }: { model: PriorityModel; stalled?: boolean; className?: string }) {
  return (
    <span data-momentum-words title={`${model.landed10} critical milestones landed in 10 days`} className={cn("whitespace-nowrap text-mark tabular-nums", className)}>
      <span className="text-sol-text">{model.landed10} landed</span>
      {/* `stalled`: a stalled priority says so here, in place of how long since. */}
      <span className="text-sol-text-dim"> · {stalled && model.stalledDays != null ? <StalledMark days={model.stalledDays} className="ml-0.5 inline-flex align-middle" /> : lastLanded(model.lastLandedDays)}</span>
    </span>
  );
}

/** Momentum: the ten days on the page's one scale, then, where the column has room, how many landed and how long since, or how long stalled. */
function Momentum({ model, todayIndex, peak, layout }: { model: PriorityModel; todayIndex: number; peak: number; layout: ListLayout }) {
  if (layout === "phone") return <DayStrip counts={model.counts} todayIndex={todayIndex} peak={peak} size="mini" />;
  return (
    <span data-momentum className="flex items-center gap-2">
      <DayStrip counts={model.counts} landed={model.landed} todayIndex={todayIndex} peak={peak} />
      <span className="hidden min-w-0 items-center gap-1 whitespace-nowrap text-mark [@container(min-width:44rem)]:flex">
        <span className="tabular-nums text-sol-text">{model.landed10} landed</span>
        <span aria-hidden className="text-sol-text-dim">·</span>
        {model.stalledDays != null
          ? <StalledMark days={model.stalledDays} className="inline-flex" />
          : <span className="tabular-nums text-sol-text-dim">{lastLanded(model.lastLandedDays)}</span>}
      </span>
    </span>
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

function PriorityHeader({ model, layout, compact, filters, todayIndex, peak, polish, onProgress, drag }: {
  model: PriorityModel;
  layout: ListLayout;
  compact: boolean;
  filters: ListFilters;
  todayIndex: number;
  peak: number;
  polish: { done: number; total: number; open: boolean; toggle: () => void } | null;
  onProgress?: () => void;
  drag?: RankDrag;
}) {
  const { row } = model;
  const wide = layout === "wide";
  // A top-three priority nothing was typed into today says so in its today cell ("0"), its title unmuted.
  const untouched = row.mine && row.status === "active" && (row.rank ?? 99) <= 3 && model.today === 0;
  // The row's own correction, when no milestone line carries it.
  const pending = row.correction_pending && !model.milestones.some((m) => m.correctionPending);
  const plan = filters.show.plans && !compact ? model.plan : null;
  return (
    <div data-priority-head className={cn(LIST_GRID[layout], "group/head relative gap-y-0.5")}>
      <Rank row={row} drag={drag} />
      {/* The title keeps 8rem and breaks between words only; a compact row's action wraps under it before the title gives way. */}
      <span className={cn(C_TITLE, "flex min-w-0 items-center gap-2", compact && "flex-wrap gap-y-1")}>
        <span title={row.summary || row.title} className={cn("min-w-[8rem] break-normal font-semibold", compact && "flex-1 basis-[8rem]", wide ? cn("truncate text-body", COARSE_WRAP) : "line-clamp-2 text-ui", "text-sol-text")}>
          {row.title}
        </span>
        {/* A compact row's strip already shows today, and Stalled sits by the strip as its mark. */}
        {!wide && !compact && (model.today > 0 || untouched) && <span data-today className="shrink-0 text-meta tabular-nums text-sol-text-dim">{model.today} today</span>}
        {/* Where the momentum column has no room for words (a narrow list), Stalled sits by the title; a phone says it on its meta line. */}
        {wide && !compact && model.stalledDays != null && <StalledMark days={model.stalledDays} className="inline-flex [@container(min-width:44rem)]:hidden" />}
        {/* On a phone and in the compact view the title keeps the row's width; the mark goes on the meta line below. */}
        {wide && !compact && pending && <PendingMark />}
        {compact && model.action && <span data-compact-action className="ml-auto flex shrink-0"><ActionButton row={row} action={model.action} showSession={false} /></span>}
      </span>
      {/* The pips end at one x on every wide row, polish or not: the polish link has a slot of its own. */}
      <span className={cn(C_PROGRESS, "flex items-center justify-end gap-2", wide && "w-full")}>
        {/* A phone's compact row keeps today as the bare count before the progress (its default row says "N today" by the title). */}
        {!wide && compact && (model.today > 0 || untouched) && <span data-today title={`${model.today} today`} aria-label={`${model.today} today`} className="text-meta tabular-nums text-sol-text-dim">{model.today}</span>}
        <Progress model={model} layout={layout} onToggle={onProgress} />
        {wide && (
          <span data-polish-slot className={cn(POLISH_SLOT, compact && "[@container(max-width:44rem)]:hidden")}>
            {polish && (
              <button type="button" data-polish aria-expanded={polish.open} onClick={polish.toggle} className={cn("inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 text-meta text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text-muted", TOUCH_AREA)}>
                Polish <span className="tabular-nums">{polish.done}/{polish.total}</span>
                <ChevronRight className={cn("size-3 transition-transform", polish.open && "rotate-90")} />
              </button>
            )}
          </span>
        )}
      </span>
      {wide ? (
        <>
          <span className="col-start-4 row-start-1 flex items-center justify-self-center gap-1">
            {compact && model.stalledDays != null && <StalledIcon days={model.stalledDays} className="inline-flex [@container(min-width:44rem)]:hidden" />}
            <span data-today className="text-meta tabular-nums text-sol-text">{model.today > 0 || untouched ? model.today : ""}</span>
          </span>
          <span className="col-start-5 row-start-1 justify-self-start"><Momentum model={model} todayIndex={todayIndex} peak={peak} layout={layout} /></span>
          <PriorityMenu row={row} reveal="group-hover/head:opacity-100" gutter className={C_MENU} />
        </>
      ) : (
        <>
          <span className="col-start-4 row-start-1 flex items-center gap-1">
            {compact && model.stalledDays != null && <StalledIcon days={model.stalledDays} className="inline-flex" />}
            <Momentum model={model} todayIndex={todayIndex} peak={peak} layout={layout} />
          </span>
          <span className={C_MENU_PHONE}><PriorityMenu row={row} touch /></span>
        </>
      )}
      {/* A phone's meta line: polish, a pending correction and the momentum words. Compact is one line a priority (its strip in the row), so it keeps only a pending correction. */}
      {!wide && (!compact || pending) && (
        <div data-meta className={cn(C_META, "flex min-h-6 items-center gap-3")}>
          {polish && !compact && (
            <button type="button" data-polish aria-expanded={polish.open} onClick={polish.toggle} className="-ml-2 inline-flex h-11 items-center gap-0.5 whitespace-nowrap rounded px-2 text-meta text-sol-text-dim hover:bg-sol-bg-alt">
              Polish <span className="tabular-nums">{polish.done}/{polish.total}</span>
              <ChevronRight className={cn("size-3 transition-transform", polish.open && "rotate-90")} />
            </button>
          )}
          {pending && <PendingMark />}
          {!compact && <MomentumWords model={model} stalled className="ml-auto" />}
        </div>
      )}
      {!wide && plan && (
        <div data-meta-plan className="col-start-2 col-end-6 row-start-3 flex min-w-0 items-center [@media(pointer:coarse)]:min-h-11">
          <PlanChip plan={plan} className="min-w-[7rem] max-w-full" />
        </div>
      )}
      {plan && wide && (
        <div data-meta className="col-start-2 col-end-3 row-start-2 flex min-h-6 min-w-0 items-center gap-1.5 overflow-hidden [@container(min-width:44rem)]:col-end-6 [@media(pointer:coarse)]:min-h-11">
          <PlanChip plan={plan} className="min-w-[7rem] max-w-[22rem]" />
        </div>
      )}
      {wide && compact && pending && <span data-meta className="col-start-2 col-end-3 row-start-2 flex min-w-0 items-center"><PendingMark /></span>}
      {/* A narrow wide list (Daylight beside the inbox) has no room for the words beside the strip: they go on the meta line under it, compact or not. */}
      {/* Compact stays one line: there the words show only beside the strip, where they fit. */}
      {wide && !compact && <MomentumWords model={model} className="col-start-3 col-end-6 row-start-2 justify-self-end [@container(min-width:44rem)]:hidden" />}
    </div>
  );
}

/**
 * A milestone's chips on a wide line: one row that never wraps, first to
 * last: the priority's action (its button, then "in ‹session›", which
 * ellipsizes down to 5rem), else the bracket's head session or the line's
 * own session (a chip of at least 5rem); then "+N" more sessions ("+N
 * sessions" on a line with no session named, when it fits); then one
 * glyph-and-count chip per other kind the Show filter asks for; then the
 * plan. The row measures itself (fitLine): with no room the plan leaves
 * first (it shows only once the session's words have up to 12rem and its
 * own title 8rem), then the counts from the end. The action, its session
 * and "+N" never leave. The open line lists all.
 */
function LineChips({ model, m, railed, filters, lookups }: {
  model: PriorityModel;
  m: MilestoneModel;
  railed: RailPart | null;
  filters: ListFilters;
  lookups: LinkLookups;
}) {
  const { action } = model;
  // Under the bracket the driver is named once, at its head; the other lines show their own sessions.
  const driver = railed ? model.rail?.session : undefined;
  const own = driver ? m.sessions.filter((s) => s.conversation_id !== driver.conversation_id) : m.sessions;
  const mine = action?.milestone.key === m.key ? action : null;
  const lead: ReactNode[] = [];
  let shown: SessionLine | undefined;
  if (mine) {
    lead.push(<span key="act" data-fit="fixed" className="flex shrink-0"><ActionButton row={model.row} action={mine} showSession={false} /></span>);
    if (mine.session) lead.push(<span key="in" data-fit="label" className={cn(LABEL_SLOT, "items-center overflow-hidden")}><InSession s={mine.session} /></span>);
    shown = mine.session;
  } else if (driver && railed === "head") {
    lead.push(<span key="drv" data-fit="label" className={LABEL_SLOT}><SessionSlot s={driver} className="min-w-0 max-w-full" /></span>);
  } else if (filters.show.sessions && !m.done) {
    shown = own.find(asksPerson) ?? bestSession(own);
    if (shown) lead.push(<span key="s" data-fit="label" className={LABEL_SLOT}><SessionSlot s={shown} className="min-w-0 max-w-full" /></span>);
  }
  const others = filters.show.sessions && !m.done ? own.filter((s) => s !== shown).length + m.more : 0;
  const kinds = m.done ? [] : kindCounts(m, filters, lookups);
  const plan = filters.show.plans ? m.plan : null;
  // "+N" with no session named before it.
  const lone = others > 0 && lead.length === (mine ? 1 : 0);
  // What fits, measured: re-measured whenever the row's width or what it holds changes.
  const parts = `${lead.length}|${others}|${kinds.map((k) => `${k.kind}${k.n}`).join(",")}|${plan?.short_id ?? ""}`;
  // Shown with the plan: the session words' and the plan's own widths, held so neither gives way to the other.
  const [fit, setFit] = useState<{ parts: string; kinds: number; plan: boolean; words: boolean; label?: number; planMin?: number } | null>(null);
  const width = useRef(0);
  const row = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const measureRow = useCallback((el: HTMLSpanElement | null) => {
    row.current = el;
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w === width.current) return;
      width.current = w;
      setFit(null);
    });
    observer.current.observe(el);
  }, []);
  useMountEffect(() => () => observer.current?.disconnect());
  const measuring = !fit || fit.parts !== parts;
  useLayoutEffect(() => {
    if (!measuring || !row.current) return;
    const el = row.current;
    // Not laid out (hidden, or no layout engine): nothing to measure, so nothing leaves.
    if (!(el.clientWidth > 0)) return setFit({ parts, kinds: kinds.length, plan: !!plan, words: lone });
    const style = getComputedStyle(el);
    const room = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const all = (kind: string) => [...el.children].filter((c) => (c as HTMLElement).dataset.fit === kind) as HTMLElement[];
    const widths = (kind: string) => all(kind).map((c) => c.offsetWidth);
    const words = el.querySelector<HTMLElement>("[data-more-words]")?.offsetWidth ?? 0;
    const labels = all("label").map(naturalWidth);
    // The plan's chrome as drawn, and its title's words up to 8rem.
    const planEl = all("plan")[0];
    const planTitle = planEl?.querySelector<HTMLElement>("[data-plan-title]");
    const planMin = planEl && planTitle ? planEl.offsetWidth - planTitle.clientWidth + Math.min(planTitle.scrollWidth, LINE_PLAN_TITLE_MIN) : undefined;
    const fitted = fitLine({
      room,
      gap: parseFloat(style.columnGap) || 0,
      fixed: [...widths("fixed"), ...widths("more").map((w) => w - words)],
      labels,
      kinds: widths("kind"),
      plan: planMin ?? null,
      words: lone ? words : 0,
    });
    setFit({ parts, ...fitted, ...(fitted.plan && { label: Math.min(labels[0] ?? 0, LINE_LABEL_MAX), planMin }) });
  });
  const shownKinds = measuring ? kinds : kinds.slice(0, fit!.kinds);
  // With the plan shown, the session's words and the plan's title keep the widths the fit gave them.
  const held = !measuring && fit!.plan ? ({ "--line-label": `${fit!.label}px`, "--line-plan": `${fit!.planMin}px` } as CSSProperties) : undefined;
  return (
    <span ref={measureRow} data-line-chips style={held} className="flex h-8 min-w-0 flex-1 flex-nowrap items-center gap-x-1.5 overflow-hidden pl-3 [@media(pointer:coarse)]:h-12">
      {lead}
      {others > 0 && (
        <span data-fit="more" data-more-sessions title={`${others} more ${others === 1 ? "session" : "sessions"}`} aria-label={`${others} more ${others === 1 ? "session" : "sessions"}`} className="inline-flex h-6 shrink-0 items-center whitespace-nowrap text-meta tabular-nums text-sol-text-dim">
          +{others}
          {lone && (measuring || fit!.words) && <span data-more-words>&nbsp;{others === 1 ? "session" : "sessions"}</span>}
        </span>
      )}
      {shownKinds.map((k) => <span key={k.kind} data-fit="kind" className="flex shrink-0"><KindCount kind={k.kind} n={k.n} /></span>)}
      {plan && (measuring || fit!.plan) && (
        <span data-fit="plan" className="flex min-w-[var(--line-plan,0px)] shrink"><PlanChip plan={plan} bar={false} className="min-w-0 max-w-[16rem]" /></span>
      )}
    </span>
  );
}

/** A line's session words: at least 5rem, and with the plan shown the width the fit held for them (up to 12rem). */
const LABEL_SLOT = "flex min-w-[max(5rem,var(--line-label,0px))] shrink";

/** A part's width with its words whole: as drawn, plus whatever its ellipsis hides. */
const naturalWidth = (el: HTMLElement) => el.offsetWidth + Math.max(0, ...[...el.querySelectorAll<HTMLElement>("*")].map((d) => d.scrollWidth - d.clientWidth));

/** The other kinds of link the Show filter asks for that a milestone has, each as its count. */
function kindCounts(m: MilestoneModel, filters: ListFilters, lookups: LinkLookups): Array<{ kind: LinkKind; n: number }> {
  return [
    { kind: "task" as const, n: filters.show.tasks ? m.tasks.length : 0 },
    { kind: "pr" as const, n: filters.show.prs ? m.prs.length : 0 },
    { kind: "branch" as const, n: filters.show.branches ? branchesOf(m, lookups).length : 0 },
    { kind: "deploy" as const, n: filters.show.deploys ? lookups.deploysOf(m).length : 0 },
  ].filter((k) => k.n > 0);
}

/** Where each part of the bracket sits in its line, and its edges. */
const RAIL: Record<RailPart, { at: string; edge: string }> = {
  head: { at: "top-1/2 bottom-0", edge: "border-t-2 rounded-tl-[3px]" },
  mid: { at: "inset-y-0", edge: "" },
  end: { at: "top-0 bottom-1/2", edge: "border-b-2 rounded-bl-[3px]" },
};

function MilestoneLine({ model, m, layout, filters, rail, open, onToggle, now, lookups }: {
  model: PriorityModel;
  m: MilestoneModel;
  layout: ListLayout;
  filters: ListFilters;
  rail: RailPart | null;
  open: boolean;
  onToggle: () => void;
  now: number;
  lookups: LinkLookups;
}) {
  const { step } = m;
  const { row } = model;
  const wide = layout === "wide";
  const writes = usePriorityWrites();
  const [renaming, setRenaming] = useState(false);
  const marks = (m.looksDone || m.correctionPending) && (
    <>
      {m.looksDone && <LooksDone row={row} step={step} />}
      {m.correctionPending && <PendingMark />}
    </>
  );
  const name = renaming ? (
    <MilestoneTitleInput title={step.title} onDone={(next) => { setRenaming(false); if (next) writes.renameStep(row.short_id, step.key, next); }} />
  ) : (
    <span data-milestone-title title={step.title} className={cn("min-w-0 text-ui", open ? "whitespace-normal break-words" : wide ? cn("truncate", COARSE_WRAP) : "line-clamp-2", step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : m.tier === "polish" ? "text-sol-text-muted" : "text-sol-text")}>
      {step.title}
    </span>
  );
  const title = (
    // Where the title can wrap or carry its marks under it (a coarse pointer, a phone), the box sits by its first line, not the block's middle.
    <span data-line-title className="flex min-w-0 items-start gap-2">
      {/* The owner's box takes the line's whole left gutter as its press area: the box stays where it is drawn. A teammate's is a status mark, nothing to press.
          Where the title can wrap (a coarse pointer, a phone) the press area starts 8px above the title and runs 52px, drawing the box 15px down,
          beside the first line; it takes 28px of the line's height, and the line clips it to its own rows. */}
      {row.mine
        ? <MilestoneToggle row={row} step={step} className={wide ? "-ml-[34px] h-8 pl-[34px] [@media(pointer:coarse)]:-mt-2 [@media(pointer:coarse)]:-mb-4 [@media(pointer:coarse)]:h-[52px] [@media(pointer:coarse)]:items-start [@media(pointer:coarse)]:pt-[15px]" : "-mb-4 -ml-[30px] -mt-2 h-[52px] items-start pl-[30px] pt-[15px]"} />
        : <span className="flex h-7 shrink-0 items-center"><MilestoneMark done={step.done} /></span>}
      {wide ? (
        // Under a coarse pointer (Daylight) the marks go on a line of their own under the title, as on a phone.
        // The title's first line sits in the middle of the line's first 32px, level with the box and the chips, however far it wraps.
        <span className="flex min-w-0 items-start gap-2 py-[7px] [@media(pointer:coarse)]:flex-col [@media(pointer:coarse)]:gap-0.5 [@media(pointer:coarse)]:py-1">
          <span className="flex min-w-0 max-w-full items-start gap-2">
            {name}
            {/* Shown while the line is hovered, and always where nothing hovers. */}
            {!renaming && <ChevronRight aria-hidden data-line-chevron className={cn("mt-[3px] size-3 shrink-0 text-sol-text-dim opacity-0 transition group-hover/line:opacity-100 [@media(hover:none)]:opacity-100", open && "rotate-90 opacity-100")} />}
          </span>
          {marks && <span data-milestone-marks className="flex shrink-0 items-center gap-2 [@media(pointer:coarse)]:flex-wrap">{marks}</span>}
        </span>
      ) : (
        // A phone keeps the title's width: its marks go on a line of their own under it.
        <span className="flex min-w-0 flex-col py-1">
          {name}
          {marks && <span data-milestone-marks className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">{marks}</span>}
        </span>
      )}
    </span>
  );
  return (
    <li data-milestone={m.key}>
      {/* Where the box's press area is tall (a coarse pointer, a phone) the line clips it to its own height: a tap never lands on a neighbour's box. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn(LIST_GRID[layout], "group/line relative -mx-1.5 cursor-pointer rounded-control px-1.5 hover:bg-sol-bg-alt/60", wide ? "min-h-8 items-start [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:overflow-y-clip" : "min-h-11 overflow-y-clip", open && "bg-sol-bg-alt/60")}
      >
        {wide ? (
          <>
            {/* Title and chips take the title and progress columns. The title takes 40% (at least 12rem) and the chips the rest,
                so a session's words and a plan's title fit side by side. Everything sits at the top: a wrapped title grows the line downward. */}
            <div className="col-start-2 col-end-4 row-start-1 grid min-w-0 grid-cols-[minmax(12rem,40%)_minmax(0,1fr)] items-start gap-x-3 self-stretch">
              {title}
              {/* One row that never wraps (LineChips). Under a coarse pointer the line is 48px, so each chip's 44px press area fits inside its clip.
                  The cell takes the line's whole height, and the bracket rail with it, however tall the title makes the line. */}
              <span data-line-chips-cell className="relative flex min-w-0 items-start gap-1.5 self-stretch">
                {/* It takes the pointer, so a hover names it; a press on it opens the line, as anywhere on the line.
                    At least 12px tall, so the legend's copy of it reads as a bracket too. */}
                {rail && (
                  <span aria-hidden data-rail={rail} className={cn("absolute left-0 flex w-1.5", RAIL[rail].at)}>
                    <Mark id="priority.bracket"><span className={cn("block h-full min-h-3 w-1.5 border-l-2 border-sol-text-dim/70", RAIL[rail].edge)} /></Mark>
                  </span>
                )}
                <LineChips model={model} m={m} railed={rail} filters={filters} lookups={lookups} />
              </span>
            </div>
            {/* The milestone's own messages today, under the priority's in the Today column. */}
            {m.today > 0 && <span data-line-today title={`${m.today} today`} className="col-start-4 row-start-1 flex h-8 items-center justify-self-center text-meta tabular-nums text-sol-text-muted [@media(pointer:coarse)]:h-12">{m.today}</span>}
            {row.mine && <MilestoneMenu row={row} step={step} onRename={() => setRenaming(true)} reveal="group-hover/line:opacity-100" gutter className={C_LINE_MENU} />}
          </>
        ) : (
          <>
            {/* The title keeps at least 8rem whatever trails it. */}
            <div className={cn("col-start-2 row-start-1 grid min-w-0 grid-cols-[minmax(8rem,1fr)_auto] items-center gap-x-3", row.mine ? "col-end-5" : "col-end-6")}>
              {title}
              <span className="flex justify-end">{phoneTrail(model, m)}</span>
            </div>
            {row.mine && <MilestoneMenu row={row} step={step} onRename={() => setRenaming(true)} touch className={C_MENU_PHONE} />}
          </>
        )}
      </div>
      {open && <div className={wide ? "pl-[26px]" : "pl-[22px]"}><MilestoneDetail model={model} m={m} now={now} lookups={lookups} touch={wide ? undefined : true} olderHref={milestoneHref(row.short_id, m.key)} /></div>}
    </li>
  );
}

/** A phone line's one trailing thing: the priority's action, an Answer, or its session's state in a word. */
function phoneTrail(model: PriorityModel, m: MilestoneModel): ReactNode {
  if (m.done) return null;
  if (model.action?.milestone.key === m.key) return <ActionButton row={model.row} action={model.action} tall showSession={false} />;
  const s = lineSession(model, m);
  if (!s) return null;
  return asksPerson(s) ? <AnswerSecondary s={s} showName={false} tall /> : <span className="text-meta text-sol-text-dim">{STATE_WORD[s.state]}</span>;
}

/** One session in an open milestone: Answer when it asks, else its chip; its state in words and its age; the owner's ⋯ to fix its link. */
export function SessionRow({ s, now, menu }: { s: SessionLine; now: number; menu?: ReactNode }) {
  const asks = asksPerson(s);
  return (
    <li data-session-row={s.conversation_id} className="group/session flex min-w-0 items-center gap-2 py-0.5 [@media(pointer:coarse)]:min-h-11">
      {/* Its state's word follows the chip. */}
      {asks ? <AnswerSecondary s={s} /> : <SessionChip s={s} className="max-w-[22rem]" labeled />}
      <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">
        {/* A closed session's chip already says so. */}
        {!asks && !isClosedSession(s) && <span className="text-sol-text-muted">{STATE_WORD[s.state]} · </span>}
        {ago(s.last_active_at, now)}{ago(s.last_active_at, now) === "just now" ? "" : " ago"}
      </span>
      {menu}
    </li>
  );
}

export function WorkflowRuns({ runs, now, menu }: { runs: SessionLine[]; now: number; menu?: (s: SessionLine) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (runs.length === 0) return null;
  const waiting = runs.filter(asksPerson).length;
  return (
    <div>
      <button type="button" data-runs aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex min-h-7 items-center gap-1 text-meta text-sol-text-muted hover:text-sol-text [@media(pointer:coarse)]:min-h-11">
        {runKinds(runs)}
        {waiting > 0 && <span className="font-semibold text-sol-text"> · {waiting} waiting</span>}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <ul className="pl-3">{runs.map((s) => <SessionRow key={s.conversation_id} s={s} now={now} menu={menu?.(s)} />)}</ul>}
    </div>
  );
}

/** `tall`: its chips are 44px under a coarse pointer, and the label keeps to their first line. */
export function TypeRow({ label, tall, children }: { label: string; tall?: boolean; children: ReactNode }) {
  return (
    <div data-type-row={label} className="flex min-w-0 items-start gap-2 py-0.5">
      <span className={cn("flex h-6 w-20 shrink-0 items-center text-mark font-semibold uppercase tracking-wide text-sol-text-dim", tall && "[@media(pointer:coarse)]:h-11")}>{label}</span>
      {/* A container: a chip in it gives up its extras by the row's width (PlanChip). */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 [container-type:inline-size]">{children}</div>
    </div>
  );
}

/**
 * An open milestone: one labelled row per kind of link, Sessions first
 * (people's first, workflow runs folded, each with the owner's ⋯ when the
 * session is theirs too). The Show filter governs only a closed line's chips.
 */
export function MilestoneDetail({ model, m, now, lookups, touch, olderHref }: {
  model: PriorityModel;
  m: MilestoneModel;
  now: number;
  lookups: LinkLookups;
  touch?: boolean;
  /** Where the sessions the list row does not carry are: the priority's page, open at this milestone. */
  olderHref?: string;
}) {
  const menu = (s: SessionLine) => (model.row.mine && s.mine ? <SessionMenu row={model.row} s={s} stepKey={m.key} touch={touch} /> : undefined);
  const people = m.sessions.filter((s) => !s.workflow);
  const runs = m.sessions.filter((s) => s.workflow);
  const plans: Array<{ plan: PriorityPlanRef; prefix?: string }> = [
    ...(m.plan ? [{ plan: m.plan }] : model.plan ? [{ plan: model.plan }] : []),
    ...m.partOf.map((plan) => ({ plan, prefix: "Part of" })),
  ];
  const branches = branchesOf(m, lookups);
  const deploys = lookups.deploysOf(m);
  const rows = [
    (m.sessions.length > 0 || m.more > 0) && (
      <TypeRow key="sessions" label="Sessions">
        <div className="min-w-0 flex-1">
          {people.length > 0 && <ul>{people.map((s) => <SessionRow key={s.conversation_id} s={s} now={now} menu={menu(s)} />)}</ul>}
          <WorkflowRuns runs={runs} now={now} menu={menu} />
          {m.more > 0 && (olderHref
            ? <Link href={olderHref} data-older-sessions className={cn("inline-flex min-h-7 items-center py-0.5 text-meta text-sol-text-muted hover:text-sol-text hover:underline", TOUCH_AREA)}>+{m.more} older {m.more === 1 ? "session" : "sessions"}</Link>
            : <div className="py-0.5 text-meta text-sol-text-dim">+{m.more} older {m.more === 1 ? "session" : "sessions"}</div>)}
        </div>
      </TypeRow>
    ),
    plans.length > 0 && (
      <TypeRow key="plan" label="Plan" tall>
        {plans.map(({ plan, prefix }) => <PlanChip key={plan.short_id} plan={plan} prefix={prefix} showSize={!!prefix} labeled className={cn("max-w-[24rem]", COARSE_TALL)} />)}
      </TypeRow>
    ),
    m.tasks.length > 0 && <TypeRow key="tasks" label="Tasks" tall>{m.tasks.map((t) => <TaskChip key={t} id={t} className={cn("max-w-[24rem]", COARSE_TALL)} />)}</TypeRow>,
    m.prs.length > 0 && <TypeRow key="prs" label="PRs">{m.prs.map((p) => <PrChip key={p} pr={p} state={lookups.prState(p)} />)}</TypeRow>,
    branches.length > 0 && <TypeRow key="branches" label="Branches">{branches.map((b) => <BranchChip key={b} name={b} labeled />)}</TypeRow>,
    deploys.length > 0 && <TypeRow key="deploys" label="Deploys">{deploys.map((d) => <DeployChip key={d.id} d={d} now={now} labeled />)}</TypeRow>,
  ].filter(Boolean);
  return (
    <div data-milestone-detail className="mb-2 ml-2 border-l border-sol-border/60 pl-3 pt-1">
      {rows}
      {rows.length === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}
