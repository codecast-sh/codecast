// Priorities lab (throwaway prototype): one priority in the list. A header row
// on the page's fixed grid (rank, title, progress, today, ten days, menu), a
// meta line under the title (the session working most of it, its plan, a rank
// the pass suggests), then one line per open critical milestone. Exactly one
// line, the next milestone, carries an action button. Polish and done
// milestones fold into one footer line.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowUp, Check, ChevronRight, GripVertical, MoreHorizontal } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { SESSION_STATUS } from "../../../lib/sessionStatus";
import { pastBadge, priorityHref, type PriorityWrites } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import {
  BranchChip, C_LINE, C_MENU, C_META, C_PROGRESS, C_RANK, C_STRIP, C_TITLE, C_TODAY, CorrectPopover, DeployChip, GRID, LabStrip, LINE_SPLIT, MENU_VISIBLE_NARROW,
  OtherSessions, PlanChip, PrChip, SessionChip, stateTone, TaskChip, TodayDot, TypeRow, WhyTags,
} from "./LabParts";
import { ago, bestOf, type DeployInfo, type PlanInfo, type PrInfo, type SessionView, type ShowRefs, type TaskInfo } from "./labModel";
import { ActionButton, type NextAction } from "./nextAction";

export type MilestoneModel = {
  step: PriorityStep;
  /** Directly connected sessions, best first (spent workflow steps last). */
  sessions: SessionView[];
  counts: number[];
  sessionCounts: Map<string, number[]>;
  /** Its own plan (never the priority's), and the big plans it is part of. */
  plan: PlanInfo | null;
  partOf: PlanInfo[];
  tasks: TaskInfo[];
  prs: PrInfo[];
  branches: string[];
  deploys: DeployInfo[];
  /** The priority's driving session works this milestone too. */
  coveredByDriver: boolean;
  /** When it landed (its tasks' last close), for a done one. */
  landedAt?: number;
};

export type PriorityModel = {
  row: PriorityRow;
  counts: number[];
  landed: boolean[];
  milestones: MilestoneModel[];
  plan: PlanInfo | null;
  /** Sessions bound across at least half its open critical milestones (at most two), shown once on the meta line. */
  drivers: SessionView[];
};

export const prototype = (what: string) => () => toast(`${what}: prototype only`);

type Rail = { x: number; start: { x: number; y: number }; ticks: Array<{ y: number; joined: boolean }>; gaps: Array<[number, number]> };

export function PriorityBlock({ model, action, pageNext, show, hideDone, todayIndex, headLevels, writes, now, onOpen, suggestion, ownerCount }: {
  model: PriorityModel;
  /** Its next milestone and what to press (nextAction nextOf). */
  action: NextAction | null;
  /** This priority's next milestone is the page's one "Next". */
  pageNext: boolean;
  show: ShowRefs;
  hideDone: boolean;
  todayIndex: number;
  headLevels: number[];
  writes: PriorityWrites;
  now: number;
  onOpen: (shortId: string) => void;
  /** The pass would rank it here (a person's own order wins; they may accept). */
  suggestion?: number | null;
  /** How many active priorities the owner ranks: whether Move up / Move down apply. */
  ownerCount: number;
}) {
  const { row } = model;
  const [doneOpen, setDoneOpen] = useState(false);
  const [polishOpen, setPolishOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const past = row.status !== "active";
  const critical = model.milestones.filter((m) => m.step.tier === "critical");
  const openCritical = critical.filter((m) => !m.step.done);
  const doneCritical = critical.filter((m) => m.step.done);
  const polish = model.milestones.filter((m) => m.step.tier === "polish");
  const showDone = !hideDone || doneOpen;
  const polishShown = polish.filter((m) => !m.step.done || !hideDone);
  const drivers = show.sessions ? model.drivers : [];
  const driver = drivers[0];

  // The rail: an elbow out of the meta line's session chip, down to a dot at each milestone it covers.
  const liRef = useRef<HTMLLIElement>(null);
  const [rail, setRail] = useState<Rail | null>(null);
  useLayoutEffect(() => {
    const li = liRef.current;
    if (!li || !driver) { setRail(null); return; }
    const measure = () => {
      const start = li.querySelector("[data-rail-start]");
      const ticks = [...li.querySelectorAll("[data-rail-tick]")];
      if (!start || ticks.length === 0 || (start as HTMLElement).offsetParent === null) { setRail(null); return; }
      const lr = li.getBoundingClientRect();
      const sr = start.getBoundingClientRect();
      const t0 = ticks[0].getBoundingClientRect();
      const next: Rail = {
        x: Math.round(t0.left - lr.left - 7),
        start: { x: Math.round(sr.left - lr.left + 14), y: Math.round(sr.bottom - lr.top) },
        ticks: ticks.map((t) => {
          const r = t.getBoundingClientRect();
          return { y: Math.round(r.top - lr.top + Math.min(r.height, 28) / 2), joined: t.getAttribute("data-rail-tick") === "joined" };
        }),
        gaps: [...li.querySelectorAll("[data-lab-milestone-detail]")].map((d) => { const r = d.getBoundingClientRect(); return [Math.round(r.top - lr.top), Math.round(r.bottom - lr.top)] as [number, number]; }),
      };
      setRail((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(li);
    return () => ro.disconnect();
  }, [driver, model, polishOpen, doneOpen, openKey, show, hideDone, action]);

  const line = (m: MilestoneModel) => (
    <MilestoneLine
      key={m.step.key}
      model={model}
      m={m}
      drivers={drivers}
      action={action?.m === m ? action : null}
      pageNext={pageNext && action?.m === m}
      show={show}
      todayIndex={todayIndex}
      open={openKey === m.step.key}
      onToggle={() => setOpenKey((k) => (k === m.step.key ? null : m.step.key))}
      writes={writes}
      now={now}
    />
  );
  const footer: ReactNode[] = [];
  if (doneCritical.length > 0 && !showDone) {
    footer.push(
      <button key="done" type="button" onClick={() => setDoneOpen(true)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-sol-bg-alt hover:text-sol-text-muted">
        <Check className="size-3 text-sol-green" strokeWidth={2.5} /> {doneCritical.length} done
      </button>,
    );
  }
  if (polish.length > 0) {
    footer.push(
      <button key="polish" type="button" aria-expanded={polishOpen} onClick={() => setPolishOpen((o) => !o)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-sol-bg-alt hover:text-sol-text-muted">
        Polish <span className="tabular-nums">{polish.filter((m) => m.step.done).length}/{polish.length}</span>
        <ChevronRight className={cn("size-3 transition-transform", polishOpen && "rotate-90")} />
      </button>,
    );
  }
  const tone = driver ? stateTone(driver.status) : "";
  return (
    <li ref={liRef} data-lab-priority={row.short_id} className={cn("relative border-b border-sol-border/50 py-2.5 last:border-b-0", past && "opacity-70")}>
      <PriorityHeader model={model} show={show} drivers={drivers} todayIndex={todayIndex} levels={headLevels} writes={writes} onOpen={onOpen} suggestion={suggestion} ownerCount={ownerCount} />
      <ul className="mt-1">
        {openCritical.map(line)}
        {showDone && doneCritical.map(line)}
        {polishOpen && polishShown.length > 0 && (
          <>
            <li aria-hidden className="ml-[30px] mt-1 flex items-center gap-2 text-mark uppercase tracking-wide text-sol-text-dim/80">
              Polish <span className="h-px flex-1 bg-sol-border/50" />
            </li>
            {polishShown.map(line)}
          </>
        )}
      </ul>
      {footer.length > 0 && (
        <div className="ml-[26px] mt-0.5 flex items-center gap-1 text-meta text-sol-text-dim">
          {footer.flatMap((f, i) => (i ? [<span key={`dot${i}`} aria-hidden>·</span>, f] : [f]))}
        </div>
      )}
      {rail && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible [@container(min-width:44rem)]:block">
          {railSegments(rail).map(([a, b], i) => (
            <path
              key={a}
              d={i === 0
                ? `M ${rail.start.x} ${rail.start.y} V ${rail.start.y + 5} H ${rail.x - 5} Q ${rail.x} ${rail.start.y + 5} ${rail.x} ${rail.start.y + 10} V ${b}`
                : `M ${rail.x} ${a} V ${b}`}
              fill="none"
              stroke={tone}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
          {rail.ticks.map((t, i) => (
            <g key={i}>
              {t.joined && <path d={`M ${rail.x} ${t.y} H ${rail.x + 7}`} stroke={tone} strokeWidth={1.5} />}
              <circle cx={rail.x} cy={t.y} r={3.5} fill={tone} stroke="var(--sol-bg)" strokeWidth={1.5} />
            </g>
          ))}
        </svg>
      )}
    </li>
  );
}

/** The rail from the meta chip to its last dot, cut where an open milestone's detail sits. */
function railSegments(rail: Rail): Array<[number, number]> {
  let segs: Array<[number, number]> = [[rail.start.y, rail.ticks[rail.ticks.length - 1].y]];
  for (const [g0, g1] of rail.gaps) {
    segs = segs.flatMap(([a, b]) => (g1 <= a || g0 >= b ? [[a, b]] : [[a, g0], [g1, b]].filter(([x, y]) => y - x > 1)) as Array<[number, number]>);
  }
  return segs;
}

/** Where a priority stands: its critical pips and count, "Mark done" once every critical milestone is done, or why it is past. */
export function CriticalMeter({ row }: { row: PriorityRow }) {
  const { critical_done: d, critical_total: t } = row.counts;
  const finished = row.status === "active" && t > 0 && d === t;
  if (row.status !== "active") return <span className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>;
  if (finished) {
    return (
      <button type="button" onClick={prototype("Mark done")} title={`All ${t} critical milestones are done`} className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full bg-sol-green/15 px-2 text-[11px] font-semibold tabular-nums text-sol-green hover:bg-sol-green/25">
        <Check className="size-3" strokeWidth={3} /> {d}/{t} Mark done
      </button>
    );
  }
  if (t === 0) return null;
  return (
    <span className="flex items-center gap-1.5" title={`${d} of ${t} critical milestones done`}>
      <span className="flex gap-[2px]">
        {Array.from({ length: t }, (_, i) => (
          <i key={i} className={cn("block h-[7px] w-[7px] rounded-[1.5px]", i < d ? "bg-sol-green" : "bg-sol-text/15")} />
        ))}
      </span>
      <span className="w-7 text-right text-meta tabular-nums text-sol-text-muted">{d}/{t}</span>
    </span>
  );
}

/** The priority's menu items, shared by its row and its own page. */
export function PriorityMenuItems({ row, writes, onCorrect, ownerCount }: { row: PriorityRow; writes: PriorityWrites; onCorrect: () => void; ownerCount: number }) {
  const rank = row.rank ?? 0;
  const ranked = row.mine && row.status === "active" && rank > 0;
  return (
    <>
      {ranked && rank > 1 && <DropdownMenuItem onSelect={() => writes.rank(row.short_id, rank - 1)}>Move up</DropdownMenuItem>}
      {ranked && rank < ownerCount && <DropdownMenuItem onSelect={() => writes.rank(row.short_id, rank + 1)}>Move down</DropdownMenuItem>}
      {ranked && <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={prototype("Mark done")}>Mark done</DropdownMenuItem>
      {row.mine && row.status === "active" && <DropdownMenuItem onSelect={() => writes.setAside(row.short_id)}>Set aside</DropdownMenuItem>}
      <DropdownMenuItem onSelect={prototype("Merge into")}>Merge into…</DropdownMenuItem>
      <DropdownMenuItem onSelect={onCorrect}>Correct…</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(window.location.origin + priorityHref(row.short_id)); toast("Link copied"); }}>Copy link</DropdownMenuItem>
    </>
  );
}

function PriorityHeader({ model, show, drivers, todayIndex, levels, writes, onOpen, suggestion, ownerCount }: {
  model: PriorityModel;
  show: ShowRefs;
  drivers: SessionView[];
  todayIndex: number;
  levels: number[];
  writes: PriorityWrites;
  onOpen: (shortId: string) => void;
  suggestion?: number | null;
  ownerCount: number;
}) {
  const { row } = model;
  const today = todayIndex >= 0 ? model.counts[todayIndex] ?? 0 : 0;
  // A top-three priority nothing was typed into today reads a little quieter: it is not getting today's attention.
  const untouched = row.status === "active" && (row.rank ?? 99) <= 3 && today === 0;
  const plan = show.plans ? model.plan : null;
  const hint = suggestion != null && suggestion !== row.rank;
  const meta = drivers.length > 0 || plan || hint;
  return (
    <div className={cn(GRID, "group/head gap-y-1")}>
      <span className={cn(C_RANK, "relative text-right text-ui font-semibold tabular-nums text-sol-text-dim")}>
        {row.mine && <GripVertical aria-label="Drag to rank" className="absolute -left-4 top-1/2 size-3.5 -translate-y-1/2 cursor-grab text-sol-text-dim opacity-0 group-hover/head:opacity-100" />}
        {row.rank ?? ""}
      </span>
      <button type="button" onClick={() => onOpen(row.short_id)} title={row.summary || row.title} className={cn(C_TITLE, "truncate text-left text-body font-semibold hover:underline decoration-sol-text-dim/50 underline-offset-2", untouched ? "text-sol-text-muted" : "text-sol-text")}>
        {row.title}
      </button>
      <span className={C_PROGRESS}><CriticalMeter row={row} /></span>
      <span className={C_TODAY}><TodayDot count={today} showCount /></span>
      <span className={C_STRIP}><LabStrip counts={model.counts} landed={model.landed} todayIndex={todayIndex} levels={levels} size="head" /></span>
      <RowMenu label={`More for ${row.title}`} hoverGroup="head" subject={row.title}>
        {(correct) => <PriorityMenuItems row={row} writes={writes} onCorrect={correct} ownerCount={ownerCount} />}
      </RowMenu>
      {meta && (
        <div className={cn(C_META, "flex flex-wrap items-center gap-1.5")}>
          {drivers[0] && (
            <span data-rail-start className="flex min-w-0 max-w-full" title="Works most of this priority's milestones">
              <SessionChip s={drivers[0]} className="max-w-[20rem]" />
            </span>
          )}
          {drivers.length > 1 && <OtherSessions others={drivers.slice(1)} now={Date.now()} />}
          {plan && <PlanChip plan={plan} className="max-w-[22rem]" />}
          {hint && <RankChip to={suggestion!} from={row.rank ?? 0} />}
        </div>
      )}
    </div>
  );
}

/** The pass ranks it elsewhere: always visible, one press to accept (a big target on touch). */
function RankChip({ to, from }: { to: number; from: number }) {
  return (
    <button
      type="button"
      onClick={prototype("Accept rank")}
      title={`The pass ranks this #${to}; you have it at #${from}`}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-sol-blue/40 bg-sol-blue/10 px-2 text-[11px] font-medium text-sol-blue hover:bg-sol-blue/15 [@container(max-width:44rem)]:h-11 [@container(max-width:44rem)]:px-3 [@container(max-width:44rem)]:text-meta"
    >
      <ArrowUp className={cn("size-3", to > from && "rotate-180")} strokeWidth={2.5} />
      #{to}
      <span aria-hidden className="text-sol-blue/50">·</span>
      <span className="font-semibold">Accept</span>
    </button>
  );
}

/** A row's ⋯ menu (always shown on touch widths); its Correct… item opens the correction popover on the button. */
export function RowMenu({ label, hoverGroup, subject, children, className }: { label: string; hoverGroup: "head" | "line" | "page"; subject: string; children: (correct: () => void) => ReactNode; className?: string }) {
  const [correcting, setCorrecting] = useState(false);
  return (
    <span className={className ?? cn(C_MENU, "self-start")}>
      <CorrectPopover open={correcting} onOpenChange={setCorrecting} subject={subject}>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={label}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "rounded p-1 text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
                  hoverGroup === "head" ? "opacity-0 group-hover/head:opacity-100" : hoverGroup === "line" ? "opacity-0 group-hover/line:opacity-100" : "",
                  MENU_VISIBLE_NARROW,
                  correcting && "opacity-100",
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} onCloseAutoFocus={(e) => e.preventDefault()}>
              {children(() => setTimeout(() => setCorrecting(true), 250))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </CorrectPopover>
    </span>
  );
}

/** A milestone's chips: on the next milestone the action button first, then sessions, plan and what the filters show. */
export function milestoneChips({ model, m, drivers, action, show, now }: {
  model: PriorityModel;
  m: MilestoneModel;
  drivers: SessionView[];
  action: NextAction | null;
  show: ShowRefs;
  now: number;
}): ReactNode[] {
  const { row } = model;
  const { step } = m;
  // A session the meta line already shows is the rail's, not the line's.
  const own = m.sessions.filter((s) => !drivers.some((d) => d.short_id === s.short_id));
  const best = action ? (action.session && !drivers.some((d) => d.short_id === action.session!.short_id) ? action.session : undefined) : bestOf(own);
  const others = own.filter((s) => s !== best);
  const chips: ReactNode[] = [];
  if (action) chips.push(<ActionButton key="act" row={row} step={step} action={action} />);
  if (show.sessions && !step.done) {
    if (best) chips.push(<SessionChip key="s" s={best} hideState={action?.kind === "needs_you"} className="min-w-[6rem]" />);
    if (others.length) chips.push(<OtherSessions key="o" others={others} now={now} />);
  }
  if (show.plans && m.plan) chips.push(<PlanChip key="p" plan={m.plan} className="min-w-[5.5rem] shrink-[2]" />);
  if (show.tasks && m.tasks.length) {
    chips.push(...m.tasks.slice(0, 2).map((t) => <TaskChip key={t.short_id} task={t} />));
    if (m.tasks.length > 2) chips.push(<span key="tmore" className="shrink-0 text-meta text-sol-text-dim">+{m.tasks.length - 2}</span>);
  }
  const more = (key: string, n: number) => <span key={key} className="shrink-0 text-meta text-sol-text-dim">+{n}</span>;
  if (show.prs && m.prs.length) {
    chips.push(...m.prs.slice(0, 3).map((p) => <PrChip key={`${p.repository}#${p.number}`} pr={p} />));
    if (m.prs.length > 3) chips.push(more("prmore", m.prs.length - 3));
  }
  if (show.branches && m.branches.length) {
    chips.push(...m.branches.slice(0, 2).map((b) => <BranchChip key={b} name={b} />));
    if (m.branches.length > 2) chips.push(more("brmore", m.branches.length - 2));
  }
  if (show.deploys) chips.push(...m.deploys.map((d) => <DeployChip key={d.short_id} d={d} now={now} />));
  return chips;
}

function MilestoneLine({ model, m, drivers, action, pageNext, show, todayIndex, open, onToggle, writes, now }: {
  model: PriorityModel;
  m: MilestoneModel;
  drivers: SessionView[];
  action: NextAction | null;
  pageNext: boolean;
  show: ShowRefs;
  todayIndex: number;
  open: boolean;
  onToggle: () => void;
  writes: PriorityWrites;
  now: number;
}) {
  const { row } = model;
  const { step } = m;
  const covered = drivers.length > 0 && m.coveredByDriver && !step.done;
  const polish = step.tier === "polish";
  const chips = milestoneChips({ model, m, drivers, action, show, now });
  const hasChips = chips.length > 0;
  const today = todayIndex >= 0 ? m.counts[todayIndex] ?? 0 : 0;
  return (
    <li data-lab-milestone={step.key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn(GRID, "group/line -mx-1.5 min-h-8 cursor-pointer rounded-control px-1.5 py-[3px] hover:bg-sol-bg-alt/60", open && "bg-sol-bg-alt/60", action && "py-1")}
      >
        <div className={cn(C_LINE, LINE_SPLIT)}>
          <span className="flex min-h-7 min-w-0 items-center gap-2">
            <MilestoneRing done={step.done} polish={polish} />
            {pageNext && <span className="shrink-0 rounded-[4px] bg-sol-blue px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-sol-bg">Next</span>}
            <span title={step.title} className={cn("min-w-0 truncate text-ui", step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : polish ? "text-sol-text-muted" : "font-medium text-sol-text")}>
              {step.title}
            </span>
          </span>
          <span
            data-rail-tick={covered ? (hasChips ? "joined" : "dot") : undefined}
            className={cn(
              // One line on a wide list (chips shrink, titles first), wrapping only on a narrow one or when many kinds are shown.
              "flex min-h-7 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden pl-6 [@container(min-width:44rem)]:pl-0",
              chips.length <= 4 && "[@container(min-width:44rem)]:flex-nowrap",
              !hasChips && !covered && "[@container(max-width:44rem)]:hidden",
            )}
          >
            {chips}
          </span>
        </div>
        <span className={cn(C_TODAY, "self-start pt-[9px]")}><TodayDot count={today} /></span>
        <RowMenu label={`More for ${step.title}`} hoverGroup="line" subject={step.title}>
          {(correct) => (
            <>
              <DropdownMenuItem onSelect={prototype("Done")}>Done</DropdownMenuItem>
              <DropdownMenuItem onSelect={prototype("Rename")}>Rename</DropdownMenuItem>
              <DropdownMenuItem onSelect={prototype("Drop")}>Drop</DropdownMenuItem>
              {row.mine && (
                <DropdownMenuItem onSelect={() => writes.setStepTier(row.short_id, step.key, polish ? "critical" : "polish")}>
                  {polish ? "Move to critical" : "Move to polish"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={correct}>Correct…</DropdownMenuItem>
            </>
          )}
        </RowMenu>
      </div>
      {open && <div className="pl-[30px]"><MilestoneDetail model={model} m={m} show={show} now={now} /></div>}
    </li>
  );
}

export function MilestoneRing({ done, polish }: { done: boolean; polish: boolean }) {
  if (done) {
    return (
      <span aria-label="Done" className="flex size-[14px] shrink-0 items-center justify-center rounded-full bg-sol-green/80 text-sol-bg">
        <Check className="size-[9px]" strokeWidth={3.5} />
      </span>
    );
  }
  return <span aria-label="Open" className={cn("block size-[14px] shrink-0 rounded-full border-[1.5px]", polish ? "border-dashed border-sol-text-dim/60" : "border-sol-text-dim")} />;
}

type TypeKey = "plans" | "prs" | "branches" | "deploys" | "tasks";

/** One compact line per kind of linked object that exists: plan, PRs, branches, deploys, tasks. */
export function TypeRows({ plan, partOf, prs, branches, deploys, tasks, show, now }: {
  plan: PlanInfo | null; partOf: PlanInfo[]; prs: PrInfo[]; branches: string[]; deploys: DeployInfo[]; tasks: TaskInfo[]; show: ShowRefs; now: number;
}) {
  const [openTypes, setOpenTypes] = useState<Record<TypeKey, boolean>>({ plans: show.plans, prs: show.prs, branches: show.branches, deploys: show.deploys, tasks: show.tasks });
  const toggle = (k: TypeKey) => setOpenTypes((o) => ({ ...o, [k]: !o[k] }));
  const planCount = (plan ? 1 : 0) + partOf.length;
  return (
    <>
      {planCount > 0 && (
        <TypeRow label="Plan" count={planCount} open={openTypes.plans} onToggle={() => toggle("plans")}>
          {plan && <PlanChip plan={plan} className="max-w-[24rem]" />}
          {partOf.map((p) => <PlanChip key={p._id} plan={p} prefix="Part of" className="max-w-[24rem]" />)}
          {partOf.length > 0 && <span className="text-meta text-sol-text-dim">{partOf.map((p) => `${p.size} tasks`).join(", ")}</span>}
        </TypeRow>
      )}
      {prs.length > 0 && (
        <TypeRow label="PRs" count={prs.length} open={openTypes.prs} onToggle={() => toggle("prs")}>
          {prs.map((p) => <PrChip key={`${p.repository}#${p.number}`} pr={p} />)}
        </TypeRow>
      )}
      {branches.length > 0 && (
        <TypeRow label="Branches" count={branches.length} open={openTypes.branches} onToggle={() => toggle("branches")}>
          {branches.map((b) => <BranchChip key={b} name={b} />)}
        </TypeRow>
      )}
      {deploys.length > 0 && (
        <TypeRow label="Deploys" count={deploys.length} open={openTypes.deploys} onToggle={() => toggle("deploys")}>
          {deploys.map((d) => <DeployChip key={d.short_id} d={d} now={now} />)}
        </TypeRow>
      )}
      {tasks.length > 0 && (
        <TypeRow label="Tasks" count={tasks.length} open={openTypes.tasks} onToggle={() => toggle("tasks")}>
          {tasks.map((t) => <TaskChip key={t.short_id} task={t} className="max-w-[24rem]" />)}
        </TypeRow>
      )}
    </>
  );
}

/** A session with its state, last activity and why it is connected. */
export function SessionLine({ s, now }: { s: SessionView; now: number }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5">
      <SessionChip s={s} hideState className="max-w-[22rem]" />
      <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">
        {s.status && <span className={cn(SESSION_STATUS[s.status].text, (s.status === "needs_you" || s.status === "error") && "font-semibold")}>{SESSION_STATUS[s.status].word}</span>}
        {s.status && s.updated_at ? " · " : ""}
        {s.updated_at ? ago(s.updated_at, now) : ""}
      </span>
      <WhyTags why={s.why} className="hidden [@container(min-width:30rem)]:flex" />
    </li>
  );
}

/** An open milestone: its linked objects, one line per kind, then all its sessions. */
export function MilestoneDetail({ model, m, show, now }: { model: PriorityModel; m: MilestoneModel; show: ShowRefs; now: number }) {
  const plan = m.plan ?? model.plan;
  const any = (plan ? 1 : 0) + m.partOf.length + m.prs.length + m.branches.length + m.deploys.length + m.tasks.length + m.sessions.length;
  return (
    <div data-lab-milestone-detail className="mb-2 ml-3 border-l border-sol-border/60 pl-3">
      <div className="pt-1">
        <TypeRows plan={plan} partOf={m.partOf} prs={m.prs} branches={m.branches} deploys={m.deploys} tasks={m.tasks} show={show} now={now} />
      </div>
      {m.sessions.length > 0 && (
        <>
          <div className="mb-1 mt-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Sessions</div>
          <ul>{m.sessions.map((s) => <SessionLine key={s.short_id} s={s} now={now} />)}</ul>
        </>
      )}
      {any === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}
