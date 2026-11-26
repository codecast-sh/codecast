// Priorities lab (throwaway prototype): one priority as a flat header row and
// one line per open critical milestone under it; polish and done milestones
// fold into one footer line. A session working most of the priority sits once
// on the header, with a rail in its state's colour down to the milestones it
// covers. The block is one grid (LabParts BLOCK_GRID), its rows subgrids.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowUp, Check, ChevronRight, GripVertical, MoreHorizontal, Play } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { EntityIdPill } from "../../EntityIdPill";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { SESSION_STATUS } from "../../../lib/sessionStatus";
import { newSessionHref, pastBadge, priorityHref, type PriorityWrites } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import {
  BLOCK_GRID, BranchChip, C_CHIPS, C_MENU, C_STRIP, C_TITLE, CorrectPopover, DeployChip, LabStrip, OtherSessions, PlanChip, PrChip, ROW, SessionChip, stateTone,
  STRIP_CELL, SUBGRID, TaskChip, TypeRow, WhyTags,
} from "./LabParts";
import { ago, type DeployInfo, type PlanInfo, type PrInfo, type SessionView, type ShowRefs, type TaskInfo } from "./labModel";

export type MilestoneModel = {
  step: PriorityStep;
  /** Directly connected sessions, best first. */
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
  /** Sessions bound across at least half its open critical milestones (at most two), shown once on the header. */
  drivers: SessionView[];
};

export const prototype = (what: string) => () => toast(`${what}: prototype only`);

type Rail = { x: number; start: { x: number; y: number }; ticks: Array<{ y: number; joined: boolean }>; gaps: Array<[number, number]> };

export function PriorityBlock({ model, nextKey, show, hideDone, todayIndex, headLevels, lineLevels, writes, now, onOpen, suggestion }: {
  model: PriorityModel;
  nextKey: string | null;
  show: ShowRefs;
  hideDone: boolean;
  todayIndex: number;
  headLevels: number[];
  lineLevels: number[];
  writes: PriorityWrites;
  now: number;
  onOpen: (shortId: string) => void;
  /** The pass would rank it here (a person's own order wins; they may accept). */
  suggestion?: number | null;
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

  // The rail: an elbow out of the header's session chip, down the chip column, a dot at each milestone it covers.
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
      const next: Rail = {
        x: Math.round(sr.left - lr.left - 12),
        start: { x: Math.round(sr.left - lr.left), y: Math.round(sr.top - lr.top + sr.height / 2) },
        ticks: ticks.map((t) => {
          const r = t.getBoundingClientRect();
          return { y: Math.round(r.top - lr.top + Math.min(r.height, 24) / 2), joined: t.getAttribute("data-rail-tick") === "joined" };
        }),
        // An open milestone's detail breaks the rail instead of running through it.
        gaps: [...li.querySelectorAll("[data-lab-milestone-detail]")].map((d) => { const r = d.getBoundingClientRect(); return [Math.round(r.top - lr.top), Math.round(r.bottom - lr.top)] as [number, number]; }),
      };
      setRail((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(li);
    return () => ro.disconnect();
  }, [driver, model, polishOpen, doneOpen, openKey, show, hideDone]);

  const line = (m: MilestoneModel) => (
    <MilestoneLine
      key={m.step.key}
      model={model}
      m={m}
      drivers={drivers}
      next={nextKey === `${row.short_id}:${m.step.key}`}
      show={show}
      todayIndex={todayIndex}
      levels={lineLevels}
      open={openKey === m.step.key}
      onToggle={() => setOpenKey((k) => (k === m.step.key ? null : m.step.key))}
      writes={writes}
      now={now}
    />
  );
  const polishDone = polish.filter((m) => m.step.done).length;
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
        Polish <span className="tabular-nums">{polishDone}/{polish.length}</span>
        <ChevronRight className={cn("size-3 transition-transform", polishOpen && "rotate-90")} />
      </button>,
    );
  }
  const tone = driver ? stateTone(driver.status) : "";
  return (
    <li ref={liRef} data-lab-priority={row.short_id} className={cn("relative border-b border-sol-border/50 py-2.5 last:border-b-0", BLOCK_GRID, past && "opacity-70")}>
      <PriorityHeader model={model} show={show} drivers={drivers} todayIndex={todayIndex} levels={headLevels} writes={writes} onOpen={onOpen} suggestion={suggestion} />
      <ul className={cn("mt-0.5", SUBGRID)}>
        {openCritical.map(line)}
        {showDone && doneCritical.map(line)}
        {polishOpen && polishShown.length > 0 && (
          <>
            <li aria-hidden className="col-span-full ml-3 mt-1 flex items-center gap-2 text-mark uppercase tracking-wide text-sol-text-dim/80 [@container(min-width:44rem)]:ml-8">
              Polish <span className="h-px flex-1 bg-sol-border/50" />
            </li>
            {polishShown.map(line)}
          </>
        )}
      </ul>
      {footer.length > 0 && (
        <div className="col-span-full ml-2 mt-0.5 flex items-center gap-1 text-meta text-sol-text-dim [@container(min-width:44rem)]:ml-7">
          {footer.flatMap((f, i) => (i ? [<span key={`dot${i}`} aria-hidden>·</span>, f] : [f]))}
        </div>
      )}
      {rail && (
        <svg aria-hidden className="pointer-events-none absolute inset-0 hidden h-full w-full overflow-visible [@container(min-width:44rem)]:block">
          {railSegments(rail).map(([a, b], i) => (
            <path
              key={a}
              d={i === 0 ? `M ${rail.start.x} ${rail.start.y} H ${rail.x + 5} Q ${rail.x} ${rail.start.y} ${rail.x} ${rail.start.y + 5} V ${b}` : `M ${rail.x} ${a} V ${b}`}
              fill="none"
              stroke={tone}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
          {rail.ticks.map((t, i) => (
            <g key={i}>
              {t.joined && <path d={`M ${rail.x} ${t.y} H ${rail.x + 11}`} stroke={tone} strokeWidth={1.5} />}
              <circle cx={rail.x} cy={t.y} r={3.5} fill={tone} stroke="var(--sol-bg)" strokeWidth={1.5} />
            </g>
          ))}
        </svg>
      )}
    </li>
  );
}

/** The rail from the header chip to its last dot, cut where an open milestone's detail sits. */
function railSegments(rail: Rail): Array<[number, number]> {
  let segs: Array<[number, number]> = [[rail.start.y, rail.ticks[rail.ticks.length - 1].y]];
  for (const [g0, g1] of rail.gaps) {
    segs = segs.flatMap(([a, b]) => (g1 <= a || g0 >= b ? [[a, b]] : [[a, g0], [g1, b]].filter(([x, y]) => y - x > 1)) as Array<[number, number]>);
  }
  return segs;
}

/** Where a priority stands: its critical meter, "Mark done?" once every critical milestone is done, or why it is past. */
export function CriticalMeter({ row }: { row: PriorityRow }) {
  const { critical_done: d, critical_total: t } = row.counts;
  const finished = row.status === "active" && t > 0 && d === t;
  if (row.status !== "active") return <span className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>;
  if (finished) {
    return (
      <button type="button" onClick={prototype("Mark done")} className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full bg-sol-green/15 px-2.5 text-meta font-semibold tabular-nums text-sol-green hover:bg-sol-green/25">
        <Check className="size-3" strokeWidth={3} /> {d}/{t} · Mark done?
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
export function PriorityMenuItems({ row, writes, onCorrect }: { row: PriorityRow; writes: PriorityWrites; onCorrect: () => void }) {
  return (
    <>
      <DropdownMenuItem onSelect={prototype("Mark done")}>Mark done</DropdownMenuItem>
      {row.mine && row.status === "active" && <DropdownMenuItem onSelect={() => writes.setAside(row.short_id)}>Set aside</DropdownMenuItem>}
      <DropdownMenuItem onSelect={prototype("Merge into")}>Merge into…</DropdownMenuItem>
      <DropdownMenuItem onSelect={onCorrect}>Correct…</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(window.location.origin + priorityHref(row.short_id)); toast("Link copied"); }}>Copy link</DropdownMenuItem>
    </>
  );
}

function PriorityHeader({ model, show, drivers, todayIndex, levels, writes, onOpen, suggestion }: {
  model: PriorityModel;
  show: ShowRefs;
  drivers: SessionView[];
  todayIndex: number;
  levels: number[];
  writes: PriorityWrites;
  onOpen: (shortId: string) => void;
  suggestion?: number | null;
}) {
  const { row } = model;
  const meter = <CriticalMeter row={row} />;
  return (
    <div className={cn(ROW, "group/head min-h-9")}>
      <div className={cn(C_TITLE, "flex items-center gap-1.5")}>
        <span className="flex w-[30px] shrink-0 items-center justify-end">
          {row.mine && <GripVertical aria-label="Drag to rank" className="size-3.5 shrink-0 cursor-grab text-sol-text-dim opacity-0 group-hover/head:opacity-100" />}
          <span className="w-4 text-right text-ui font-semibold tabular-nums text-sol-text-dim">{row.rank ?? ""}</span>
        </span>
        {suggestion != null && suggestion !== row.rank && <RankHint to={suggestion} from={row.rank ?? 0} />}
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <button type="button" onClick={() => onOpen(row.short_id)} className="min-w-0 truncate text-left text-body font-semibold text-sol-text hover:underline decoration-sol-text-dim/50 underline-offset-2" title={row.summary || row.title}>
            {row.title}
          </button>
          <span className="hidden shrink-0 font-mono text-meta text-sol-text-dim [@container(min-width:30rem)]:inline">{row.short_id}</span>
          {row.serves && <span className="hidden min-w-0 shrink overflow-hidden whitespace-nowrap text-meta [&_*]:!whitespace-nowrap [@container(min-width:30rem)]:inline-flex"><EntityIdPill shortId={row.serves} type="initiative" compact /></span>}
        </span>
        <span className="ml-auto flex shrink-0 pl-2">{meter}</span>
      </div>
      <div className={cn(C_CHIPS, "flex items-center gap-1.5 overflow-hidden pl-[34px] empty:hidden [@container(min-width:44rem)]:pl-0")}>
        {drivers[0] && (
          <span data-rail-start className="flex min-w-[6rem] shrink [@container(min-width:44rem)]:ml-5" title="Works most of this priority's milestones">
            <SessionChip s={drivers[0]} className="w-full" />
          </span>
        )}
        {drivers.length > 1 && <OtherSessions others={drivers.slice(1)} now={Date.now()} />}
        {show.plans && model.plan && <PlanChip plan={model.plan} className="min-w-[7rem] max-w-[13rem] shrink-[3]" />}
      </div>
      <span className={C_STRIP}><LabStrip counts={model.counts} landed={model.landed} todayIndex={todayIndex} levels={levels} size="head" /></span>
      <RowMenu label={`More for ${row.title}`} hoverGroup="head" subject={row.title}>
        {(correct) => <PriorityMenuItems row={row} writes={writes} onCorrect={correct} />}
      </RowMenu>
    </div>
  );
}

/** The pass would put this priority at another rank: say so quietly, accept on hover. */
function RankHint({ to, from }: { to: number; from: number }) {
  return (
    <span className="group/hint inline-flex shrink-0 items-center gap-0.5 self-center rounded-full bg-sol-blue/10 py-px pl-1 pr-1.5 text-[11px] font-medium leading-4 text-sol-blue" title={`The pass ranks this #${to}; you have it at #${from}`}>
      <ArrowUp className={cn("size-3", to > from && "rotate-180")} strokeWidth={2.5} />
      <span className="hidden group-hover/hint:inline">pass suggests </span>#{to}
      <button type="button" onClick={prototype("Accept rank")} className="ml-1 hidden rounded-full bg-sol-blue px-1.5 text-sol-bg group-hover/hint:inline">Accept</button>
    </span>
  );
}

/** A row's ⋯ menu; its Correct… item opens the correction popover anchored on the button. */
export function RowMenu({ label, hoverGroup, subject, children }: { label: string; hoverGroup: "head" | "line" | "page"; subject: string; children: (correct: () => void) => ReactNode }) {
  const [correcting, setCorrecting] = useState(false);
  return (
    <span className={cn(C_MENU, "self-start justify-self-end")}>
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
                  correcting && "opacity-100",
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
              {children(() => setTimeout(() => setCorrecting(true), 60))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </CorrectPopover>
    </span>
  );
}

/** "▶ Start": a new session on this milestone, its task attached. */
export function StartButton({ row, step }: { row: PriorityRow; step: PriorityStep }) {
  return (
    <Link
      href={newSessionHref(row, step)}
      onClick={(e) => e.stopPropagation()}
      title="Start a session on this milestone"
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-sol-blue/55 px-2.5 text-meta font-medium text-sol-blue hover:border-solid hover:bg-sol-blue/10"
    >
      <Play className="size-2.5 fill-current" /> Start
    </Link>
  );
}

function MilestoneLine({ model, m, drivers, next, show, todayIndex, levels, open, onToggle, writes, now }: {
  model: PriorityModel;
  m: MilestoneModel;
  drivers: SessionView[];
  next: boolean;
  show: ShowRefs;
  todayIndex: number;
  levels: number[];
  open: boolean;
  onToggle: () => void;
  writes: PriorityWrites;
  now: number;
}) {
  const { row } = model;
  const { step } = m;
  const covered = drivers.length > 0 && m.coveredByDriver && !step.done;
  // A covered line leaves its session slot to the rail's dot, and shows a session of its own beside it if it has one.
  const own = drivers.length ? m.sessions.filter((s) => !drivers.some((d) => d.short_id === s.short_id)) : m.sessions;
  const [best, ...others] = own;
  const polish = step.tier === "polish";
  const chips: ReactNode[] = [];
  if (show.sessions && !step.done) {
    if (best) chips.push(<SessionChip key="s" s={best} className="min-w-[7rem]" />);
    else if (!covered) chips.push(<StartButton key="start" row={row} step={step} />);
    if (others.length) chips.push(<OtherSessions key="o" others={others} now={now} />);
  }
  if (show.plans && m.plan) chips.push(<PlanChip key="p" plan={m.plan} />);
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
  return (
    <li data-lab-milestone={step.key} className={SUBGRID}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn(ROW, "group/line -mx-1.5 min-h-8 cursor-pointer items-start rounded-control px-1.5 py-[3px] hover:bg-sol-bg-alt/60", open && "bg-sol-bg-alt/60")}
      >
        <span className={cn(C_TITLE, "flex min-h-6 items-center gap-2 pl-2 [@container(min-width:44rem)]:pl-[34px]")}>
          <MilestoneRing done={step.done} polish={polish} />
          {next && <span className="shrink-0 rounded-[4px] bg-sol-blue px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-sol-bg">Next</span>}
          <span title={step.title} className={cn("min-w-0 truncate text-ui", step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : polish ? "text-sol-text-muted" : "font-medium text-sol-text")}>
            {step.title}
          </span>
        </span>
        <span
          data-rail-tick={covered ? (best ? "joined" : "dot") : undefined}
          className={cn(
            C_CHIPS,
            "flex min-h-6 items-center gap-x-1.5 gap-y-1 overflow-hidden pl-[30px]",
            chips.length > 3 ? "flex-wrap" : "[@container(max-width:44rem)]:flex-wrap",
            drivers.length > 0 ? "[@container(min-width:44rem)]:pl-5" : "[@container(min-width:44rem)]:pl-0",
            chips.length === 0 && !covered && "[@container(max-width:44rem)]:hidden",
          )}
        >
          {chips}
        </span>
        <span className={cn(C_STRIP, "self-start pt-[7px]")}><LabStrip counts={m.counts} todayIndex={todayIndex} levels={levels} size="line" /></span>
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
      {open && <div className="col-span-full"><MilestoneDetail model={model} m={m} show={show} todayIndex={todayIndex} levels={levels} now={now} /></div>}
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
          {plan && <PlanChip plan={plan} />}
          {partOf.map((p) => <PlanChip key={p._id} plan={p} prefix="Part of" className="max-w-[20rem]" />)}
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
export function SessionLine({ s, counts, todayIndex, levels, now }: { s: SessionView; counts?: number[]; todayIndex: number; levels: number[]; now: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 py-0.5 [@container(min-width:44rem)]:grid-cols-[minmax(0,1fr)_52px_24px]">
      <span className="flex min-w-0 items-center gap-2">
        <SessionChip s={s} className="max-w-[22rem]" />
        <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">
          {s.status && <span className={SESSION_STATUS[s.status].text}>{SESSION_STATUS[s.status].word}</span>}
          {s.status && s.updated_at ? " · " : ""}
          {s.updated_at ? ago(s.updated_at, now) : ""}
        </span>
        <WhyTags why={s.why} className="hidden [@container(min-width:30rem)]:flex" />
      </span>
      {counts && <span className={STRIP_CELL}><LabStrip counts={counts} todayIndex={todayIndex} levels={levels} size="line" /></span>}
      <span className="hidden [@container(min-width:44rem)]:block" />
    </li>
  );
}

function MilestoneDetail({ model, m, show, todayIndex, levels, now }: { model: PriorityModel; m: MilestoneModel; show: ShowRefs; todayIndex: number; levels: number[]; now: number }) {
  const plan = m.plan ?? model.plan;
  const any = (plan ? 1 : 0) + m.partOf.length + m.prs.length + m.branches.length + m.deploys.length + m.tasks.length + m.sessions.length;
  return (
    <div data-lab-milestone-detail className="mb-2 ml-4 border-l border-sol-border/60 pl-3 [@container(min-width:44rem)]:ml-[56px]">
      <div className="pt-1">
        <TypeRows plan={plan} partOf={m.partOf} prs={m.prs} branches={m.branches} deploys={m.deploys} tasks={m.tasks} show={show} now={now} />
      </div>
      {m.sessions.length > 0 && (
        <>
          <div className="mb-1 mt-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Sessions</div>
          <ul>{m.sessions.map((s) => <SessionLine key={s.short_id} s={s} counts={m.sessionCounts.get(s.short_id) ?? []} todayIndex={todayIndex} levels={levels} now={now} />)}</ul>
        </>
      )}
      {any === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}
