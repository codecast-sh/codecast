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
import { useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { PriorityPlanRef } from "@codecast/shared/contracts/priorities";
import { asksPerson, bestSession, isClosedSession } from "@codecast/shared/contracts/priorityDerive";
import { pastBadge, rankProvenance, type PriorityRow } from "../../lib/priorities";
import { LIST_GRID, STATE_WORD, ago, runKinds, type ListFilters, type ListLayout, type MilestoneModel, type PriorityModel, type SessionLine } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { branchesOf, type LinkLookups } from "../../hooks/usePriorityModels";
import { usePriorityWrites } from "../../hooks/usePriorities";
import { ActionButton, AnswerSecondary, BranchChip, DayStrip, DeployChip, MilestoneBox, PlanChip, PrChip, SessionChip, SessionSlot, TaskChip } from "./parts";
import { MilestoneMenu, MilestoneTitleInput, MilestoneToggle, PriorityMenu, SessionMenu } from "./controls";

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
const C_MENU = "col-start-6 row-start-1 justify-self-end";
const C_MENU_PHONE = "col-start-5 row-start-1 justify-self-end";

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
        <span className="flex gap-[2px]">
          {Array.from({ length: t }, (_, i) => <i key={i} className={cn("block h-[7px] w-[7px] rounded-[1.5px]", i < d ? "bg-sol-green" : "bg-sol-text/15")} />)}
        </span>
      )}
      <span data-progress className="text-meta tabular-nums text-sol-text-muted">{d}/{t}</span>
    </>
  );
  return onToggle
    ? <button type="button" onClick={onToggle} title={`${d} of ${t} critical milestones done: show them`} className="flex items-center gap-1.5 rounded px-1 hover:bg-sol-bg-alt">{body}</button>
    : <span className="flex items-center gap-1.5 px-1" title={`${d} of ${t} critical milestones done`}>{body}</span>;
}

/** Stalled, in words and a diamond so it reads without colour. */
function StalledMark({ days, className }: { days: number; className?: string }) {
  return <span data-stalled className={cn("shrink-0 items-center gap-1 whitespace-nowrap text-mark font-semibold text-sol-text", className)}><i aria-hidden className="block size-[6px] rotate-45 border border-sol-text" />Stalled {days}d</span>;
}

/** "correction pending": the person's correction waits for the next pass. */
export function PendingMark() {
  return <span data-correction-pending title="Your correction waits for the next pass" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-mark text-sol-text-dim"><i aria-hidden className="block size-[5px] rounded-full border border-sol-text-dim" />correction pending</span>;
}

/** Momentum: the ten days on the page's one scale, then how many landed and how long since, or how long stalled. */
function Momentum({ model, todayIndex, peak, layout }: { model: PriorityModel; todayIndex: number; peak: number; layout: ListLayout }) {
  if (layout === "phone") return <DayStrip counts={model.counts} todayIndex={todayIndex} peak={peak} size="mini" />;
  const last = model.lastLandedDays;
  return (
    <span data-momentum className="flex items-center gap-2" title={`${model.landed10} critical milestones landed in 10 days`}>
      <DayStrip counts={model.counts} landed={model.landed} todayIndex={todayIndex} peak={peak} />
      <span className="hidden min-w-0 flex-col text-mark leading-[13px] [@container(min-width:44rem)]:flex">
        <span className="tabular-nums text-sol-text">{model.landed10} landed</span>
        {model.stalledDays != null
          ? <StalledMark days={model.stalledDays} className="inline-flex" />
          : <span className="tabular-nums text-sol-text-dim">{last == null ? "none yet" : last === 0 ? "last today" : `last ${last}d`}</span>}
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
        writes.move(row.short_id, e.key === "ArrowUp" ? "up" : "down");
      }}
      className={cn(C_RANK, "-mx-1 cursor-grab rounded px-1 hover:bg-sol-bg-alt hover:text-sol-text active:cursor-grabbing")}
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
  // A top-three priority nothing was typed into today reads a little quieter: it is not getting today's attention.
  const untouched = row.status === "active" && (row.rank ?? 99) <= 3 && model.today === 0;
  const plan = filters.show.plans && !compact ? model.plan : null;
  return (
    <div data-priority-head className={cn(LIST_GRID[layout], "gap-y-0.5")}>
      <Rank row={row} drag={drag} />
      <span className={cn(C_TITLE, "flex min-w-0 items-center gap-2")}>
        <span title={row.summary || row.title} className={cn("min-w-0 font-semibold", wide ? "truncate text-body" : "line-clamp-2 text-ui", untouched ? "text-sol-text-muted" : "text-sol-text")}>
          {row.title}
        </span>
        {!wide && model.today > 0 && <span className="shrink-0 text-meta tabular-nums text-sol-text-dim">{model.today} today</span>}
        {/* Where the momentum column has no room for words (a narrow list, a phone), Stalled sits by the title. */}
        {model.stalledDays != null && <StalledMark days={model.stalledDays} className={wide ? "inline-flex [@container(min-width:44rem)]:hidden" : "inline-flex"} />}
        {row.correction_pending && !model.milestones.some((m) => m.correctionPending) && <PendingMark />}
        {compact && model.action && <span data-compact-action className="ml-auto flex shrink-0"><ActionButton row={row} action={model.action} showSession={false} /></span>}
      </span>
      {/* One width on every wide row, so the compact view's actions line up. */}
      <span className={cn(C_PROGRESS, "flex items-center justify-end gap-2", wide && "min-w-[10.5rem]")}>
        <Progress model={model} layout={layout} onToggle={onProgress} />
        {wide && polish && (
          <button type="button" data-polish aria-expanded={polish.open} onClick={polish.toggle} className="inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 text-meta text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text-muted">
            Polish <span className="tabular-nums">{polish.done}/{polish.total}</span>
            <ChevronRight className={cn("size-3 transition-transform", polish.open && "rotate-90")} />
          </button>
        )}
      </span>
      {wide ? (
        <>
          <span data-today className="col-start-4 row-start-1 justify-self-center text-meta tabular-nums text-sol-text">{model.today > 0 ? model.today : ""}</span>
          <span className="col-start-5 row-start-1 justify-self-start"><Momentum model={model} todayIndex={todayIndex} peak={peak} layout={layout} /></span>
          <span className={C_MENU}><PriorityMenu row={row} touch={false} /></span>
        </>
      ) : (
        <>
          <span className="col-start-4 row-start-1"><Momentum model={model} todayIndex={todayIndex} peak={peak} layout={layout} /></span>
          <span className={C_MENU_PHONE}><PriorityMenu row={row} touch /></span>
        </>
      )}
      {!wide && polish && !compact && (
        <div data-meta className={cn(C_META, "flex items-center")}>
          <button type="button" data-polish aria-expanded={polish.open} onClick={polish.toggle} className="-ml-2 inline-flex h-11 items-center gap-0.5 whitespace-nowrap rounded px-2 text-meta text-sol-text-dim hover:bg-sol-bg-alt">
            Polish <span className="tabular-nums">{polish.done}/{polish.total}</span>
            <ChevronRight className={cn("size-3 transition-transform", polish.open && "rotate-90")} />
          </button>
        </div>
      )}
      {plan && wide && (
        <div data-meta className={cn(C_META, "flex min-h-6 items-center gap-1.5 overflow-hidden")}>
          <PlanChip plan={plan} className="min-w-[7rem] max-w-[22rem]" />
        </div>
      )}
    </div>
  );
}

/**
 * A milestone's chips on a wide line, in the order they give way: the
 * bracket's head session where the driver starts, the priority's action on its
 * line, else one session (Answer when it asks); then "+N sessions" and what
 * the Show filter asks for.
 */
function lineChips({ model, m, railed, filters, now, lookups }: {
  model: PriorityModel;
  m: MilestoneModel;
  railed: RailPart | null;
  filters: ListFilters;
  now: number;
  lookups: LinkLookups;
}): ReactNode[] {
  const { action } = model;
  // Under the bracket the driver is named once, at its head; the other lines show their own sessions.
  const driver = railed ? model.rail?.session : undefined;
  const own = driver ? m.sessions.filter((s) => s.conversation_id !== driver.conversation_id) : m.sessions;
  const mine = action?.milestone.key === m.key ? action : null;
  const chips: ReactNode[] = [];
  let shown: SessionLine | undefined;
  if (mine) {
    chips.push(<ActionButton key="act" row={model.row} action={mine} />);
    shown = mine.session;
  } else if (driver && railed === "head") {
    chips.push(<SessionSlot key="drv" s={driver} className="min-w-[5rem] max-w-[14rem]" />);
  } else if (filters.show.sessions && !m.done) {
    shown = own.find(asksPerson) ?? bestSession(own);
    if (shown) chips.push(<SessionSlot key="s" s={shown} className="min-w-[4.5rem] max-w-[15rem]" />);
  }
  const others = own.filter((s) => s !== shown).length + m.more;
  if (filters.show.sessions && !m.done && others > 0) {
    chips.push(<span key="o" data-more-sessions className="inline-flex h-6 shrink-0 items-center whitespace-nowrap px-1.5 text-meta tabular-nums text-sol-text-dim">+{others} {others === 1 ? "session" : "sessions"}</span>);
  }
  if (filters.show.plans && m.plan) chips.push(<span key="p" className="flex min-w-0 shrink"><PlanChip plan={m.plan} className="min-w-[8rem] max-w-[14rem]" /></span>);
  if (filters.show.tasks) chips.push(...m.tasks.slice(0, 1).map((t) => <TaskChip key={t} id={t} />));
  if (filters.show.prs) chips.push(...m.prs.slice(0, 2).map((p) => <PrChip key={p} pr={p} state={lookups.prState(p)} />));
  if (filters.show.branches) chips.push(...branchesOf(m, lookups).slice(0, 1).map((b) => <BranchChip key={b} name={b} />));
  if (filters.show.deploys) chips.push(...lookups.deploysOf(m).slice(0, 1).map((d) => <DeployChip key={d.id} d={d} now={now} />));
  return chips;
}

const RAIL: Record<RailPart, string> = {
  head: "top-1/2 bottom-0 border-t-2 rounded-tl-[3px]",
  mid: "inset-y-0",
  end: "top-0 bottom-1/2 border-b-2 rounded-bl-[3px]",
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
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      {/* The owner's box takes the line's whole left gutter as its press area: the box stays where it is drawn. */}
      {row.mine ? <MilestoneToggle row={row} step={step} className={wide ? "-my-1 -ml-[34px] h-8 pl-[34px]" : "-my-1 -ml-[30px] h-11 pl-[30px]"} /> : <MilestoneBox done={step.done} />}
      {renaming ? (
        <MilestoneTitleInput title={step.title} onDone={(next) => { setRenaming(false); if (next) writes.renameStep(row.short_id, step.key, next); }} />
      ) : (
        <span title={step.title} className={cn("min-w-0 text-ui", wide ? "truncate" : "line-clamp-2", step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : m.tier === "polish" ? "text-sol-text-muted" : "text-sol-text")}>
          {step.title}
        </span>
      )}
      {wide && !renaming && <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-sol-text-dim opacity-0 transition group-hover/line:opacity-100", open && "rotate-90 opacity-100")} />}
      {m.looksDone && <span data-looks-done title="Every task it names is done" className="inline-flex shrink-0 items-center rounded-full border border-sol-border px-1.5 text-mark leading-[18px] text-sol-text-muted">Looks done?</span>}
      {m.correctionPending && <PendingMark />}
    </span>
  );
  return (
    <li data-milestone={m.key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn(LIST_GRID[layout], "group/line -mx-1.5 cursor-pointer rounded-control px-1.5 hover:bg-sol-bg-alt/60", wide ? "min-h-8" : "min-h-11", open && "bg-sol-bg-alt/60")}
      >
        {wide ? (
          <>
            <div className="col-start-2 col-end-4 row-start-1 grid min-w-0 grid-cols-[minmax(40%,1fr)_minmax(0,1fr)] items-center gap-x-3">
              {title}
              <span data-line-chips className="relative flex h-8 min-w-0 flex-wrap content-start items-center gap-x-1.5 gap-y-4 overflow-hidden pl-3 pt-1">
                {rail && <span aria-hidden data-rail={rail} className={cn("pointer-events-none absolute left-0 w-1.5 border-l-2 border-sol-text-dim/70", RAIL[rail])} />}
                {lineChips({ model, m, railed: rail, filters, now, lookups })}
              </span>
            </div>
            <span className="col-start-4 row-start-1 justify-self-center text-meta tabular-nums text-sol-text-muted">{m.today > 0 ? m.today : ""}</span>
            {row.mine && <MilestoneMenu row={row} step={step} sessions={m.sessions.length + m.more} onRename={() => setRenaming(true)} touch={false} reveal="group-hover/line:opacity-100" className={C_MENU} />}
          </>
        ) : (
          <>
            <div className={cn("col-start-2 row-start-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3", row.mine ? "col-end-5" : "col-end-6")}>
              {title}
              <span className="flex justify-end">{phoneTrail(model, m)}</span>
            </div>
            {row.mine && <MilestoneMenu row={row} step={step} sessions={m.sessions.length + m.more} onRename={() => setRenaming(true)} touch className={C_MENU_PHONE} />}
          </>
        )}
      </div>
      {open && <div className={wide ? "pl-[26px]" : "pl-[22px]"}><MilestoneDetail model={model} m={m} filters={filters} now={now} lookups={lookups} touch={wide ? undefined : true} /></div>}
    </li>
  );
}

/** A phone line's one trailing thing: the priority's action, an Answer, or its session's state in a word. */
function phoneTrail(model: PriorityModel, m: MilestoneModel): ReactNode {
  if (m.done) return null;
  if (model.action?.milestone.key === m.key) return <ActionButton row={model.row} action={model.action} tall showSession={false} />;
  const asking = m.sessions.find(asksPerson);
  if (asking) return <AnswerSecondary s={asking} showName={false} tall />;
  const best = bestSession(m.sessions);
  return best ? <span className="text-meta text-sol-text-dim">{STATE_WORD[best.state]}</span> : null;
}

/** One session in an open milestone: Answer when it asks, else its chip; its state in words and its age; the owner's ⋯ to fix its link. */
export function SessionRow({ s, now, menu }: { s: SessionLine; now: number; menu?: ReactNode }) {
  const asks = asksPerson(s);
  return (
    <li data-session-row={s.conversation_id} className="group/session flex min-w-0 items-center gap-2 py-0.5">
      {asks ? <AnswerSecondary s={s} /> : <SessionChip s={s} className="max-w-[22rem]" />}
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
      <button type="button" data-runs aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex min-h-7 items-center gap-1 text-meta text-sol-text-muted hover:text-sol-text">
        {runKinds(runs)}
        {waiting > 0 && <span className="font-semibold text-sol-text"> · {waiting} waiting</span>}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <ul className="pl-3">{runs.map((s) => <SessionRow key={s.conversation_id} s={s} now={now} menu={menu?.(s)} />)}</ul>}
    </div>
  );
}

export function TypeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-type-row={label} className="flex min-w-0 items-start gap-2 py-0.5">
      <span className="flex h-6 w-20 shrink-0 items-center text-mark font-semibold uppercase tracking-wide text-sol-text-dim">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** An open milestone: its sessions (people's first, workflow runs folded), each with the owner's ⋯ when the session is theirs too, then the links the Show filter asks for. */
export function MilestoneDetail({ model, m, filters, now, lookups, touch }: { model: PriorityModel; m: MilestoneModel; filters: ListFilters; now: number; lookups: LinkLookups; touch?: boolean }) {
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
    filters.show.plans && plans.length > 0 && (
      <TypeRow key="plan" label="Plan">
        {plans.map(({ plan, prefix }) => <PlanChip key={plan.short_id} plan={plan} prefix={prefix} className="max-w-[24rem]" />)}
        {m.partOf.length > 0 && <span className="text-meta text-sol-text-dim">{m.partOf.map((p) => `${p.size} tasks`).join(", ")}</span>}
      </TypeRow>
    ),
    filters.show.tasks && m.tasks.length > 0 && <TypeRow key="tasks" label="Tasks">{m.tasks.map((t) => <TaskChip key={t} id={t} className="max-w-[24rem]" />)}</TypeRow>,
    filters.show.prs && m.prs.length > 0 && <TypeRow key="prs" label="PRs">{m.prs.map((p) => <PrChip key={p} pr={p} state={lookups.prState(p)} />)}</TypeRow>,
    filters.show.branches && branches.length > 0 && <TypeRow key="branches" label="Branches">{branches.map((b) => <BranchChip key={b} name={b} />)}</TypeRow>,
    filters.show.deploys && deploys.length > 0 && <TypeRow key="deploys" label="Deploys">{deploys.map((d) => <DeployChip key={d.id} d={d} now={now} />)}</TypeRow>,
  ].filter(Boolean);
  return (
    <div data-milestone-detail className="mb-2 ml-2 border-l border-sol-border/60 pl-3 pt-1">
      {people.length > 0 && <ul>{people.map((s) => <SessionRow key={s.conversation_id} s={s} now={now} menu={menu(s)} />)}</ul>}
      <WorkflowRuns runs={runs} now={now} menu={menu} />
      {m.more > 0 && <div className="py-0.5 text-meta text-sol-text-dim">+{m.more} older {m.more === 1 ? "session" : "sessions"}</div>}
      {rows.length > 0 && <div className="mt-1">{rows}</div>}
      {m.sessions.length === 0 && rows.length === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}
