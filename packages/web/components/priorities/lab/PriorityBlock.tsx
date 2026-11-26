// Priorities lab (throwaway prototype): one priority as a flat header row and
// one line per open critical milestone under it; polish and done milestones
// fold into one footer line. A session bound across most of the priority sits
// once on the header, with a rail down to the milestones it covers.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, ChevronRight, MoreHorizontal, Play } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { EntityIdPill } from "../../EntityIdPill";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { SESSION_STATUS } from "../../../lib/sessionStatus";
import { newSessionHref, pastBadge, priorityHref, type PriorityWrites } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { BranchChip, DeployChip, LAB_GRID, LabStrip, OtherSessions, PlanChip, PrChip, ROW_SPLIT, SessionChip, STRIP_CELL, TaskChip, TypeRow, WhyTags } from "./LabParts";
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
};

export type PriorityModel = {
  row: PriorityRow;
  counts: number[];
  landed: boolean[];
  milestones: MilestoneModel[];
  plan: PlanInfo | null;
  /** Sessions bound across at least half its open milestones (at most two), shown once on the header. */
  drivers: SessionView[];
};

const prototype = (what: string) => () => toast(`${what}: prototype only`);

type Rail = { x: number; y0: number; ticks: number[] };

export function PriorityBlock({ model, nextKey, show, hideDone, todayIndex, headLevels, lineLevels, writes, now }: {
  model: PriorityModel;
  nextKey: string | null;
  show: ShowRefs;
  hideDone: boolean;
  todayIndex: number;
  headLevels: number[];
  lineLevels: number[];
  writes: PriorityWrites;
  now: number;
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

  // The driver's rail: from under its header chip down the session column, a tick at each milestone it covers.
  const liRef = useRef<HTMLLIElement>(null);
  const [rail, setRail] = useState<Rail | null>(null);
  useLayoutEffect(() => {
    const li = liRef.current;
    if (!li || drivers.length === 0) { setRail(null); return; }
    const measure = () => {
      const start = li.querySelector("[data-rail-start]");
      const ticks = [...li.querySelectorAll("[data-rail-tick]")];
      if (!start || ticks.length === 0) { setRail(null); return; }
      const lr = li.getBoundingClientRect();
      const sr = start.getBoundingClientRect();
      const next: Rail = {
        x: Math.round(sr.left - lr.left + 10),
        y0: Math.round(sr.bottom - lr.top),
        ticks: ticks.map((t) => { const r = t.getBoundingClientRect(); return Math.round(r.top - lr.top + Math.min(r.height, 32) / 2); }),
      };
      setRail((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(li);
    return () => ro.disconnect();
  }, [drivers, model, polishOpen, doneOpen, openKey, show, hideDone]);

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
  return (
    <li ref={liRef} data-lab-priority={row.short_id} className={cn("relative border-b border-sol-border/50 py-2.5 last:border-b-0", past && "opacity-70")}>
      <PriorityHeader model={model} show={show} drivers={drivers} todayIndex={todayIndex} levels={headLevels} writes={writes} />
      <ul className="mt-0.5">
        {openCritical.map(line)}
        {showDone && doneCritical.map(line)}
        {polishOpen && polishShown.length > 0 && (
          <>
            <li aria-hidden className="ml-3 mt-1 flex items-center gap-2 text-mark uppercase tracking-wide text-sol-text-dim/80 [@container(min-width:44rem)]:ml-8">
              Polish <span className="h-px flex-1 bg-sol-border/50" />
            </li>
            {polishShown.map(line)}
          </>
        )}
      </ul>
      {footer.length > 0 && (
        <div className="ml-2 mt-0.5 flex items-center gap-1 text-meta text-sol-text-dim [@container(min-width:44rem)]:ml-7">
          {footer.flatMap((f, i) => (i ? [<span key={`dot${i}`} aria-hidden>·</span>, f] : [f]))}
        </div>
      )}
      {rail && (
        <div aria-hidden className="pointer-events-none absolute inset-0 hidden [@container(min-width:44rem)]:block">
          <span className="absolute w-px bg-sol-text-dim/50" style={{ left: rail.x, top: rail.y0 + 2, height: Math.max(0, rail.ticks[rail.ticks.length - 1] - rail.y0 - 2) }} />
          {rail.ticks.map((y, i) => (
            <span key={i} className="absolute h-px w-[8px] bg-sol-text-dim/50" style={{ left: rail.x, top: y }} />
          ))}
        </div>
      )}
    </li>
  );
}

function PriorityHeader({ model, show, drivers, todayIndex, levels, writes }: { model: PriorityModel; show: ShowRefs; drivers: SessionView[]; todayIndex: number; levels: number[]; writes: PriorityWrites }) {
  const { row } = model;
  const { critical_done: d, critical_total: t } = row.counts;
  const finished = row.status === "active" && t > 0 && d === t;
  return (
    <div className={cn(LAB_GRID, "group/head min-h-9")}>
      <div className={ROW_SPLIT}>
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="w-5 shrink-0 text-right text-ui font-semibold tabular-nums text-sol-text-dim">{row.rank ?? ""}</span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <Link href={priorityHref(row.short_id)} className="min-w-0 truncate text-body font-semibold text-sol-text hover:underline decoration-sol-text-dim/50 underline-offset-2" title={row.summary || row.title}>
              {row.title}
            </Link>
            <span className="hidden shrink-0 font-mono text-meta text-sol-text-dim [@container(min-width:30rem)]:inline">{row.short_id}</span>
            {row.serves && <span className="hidden min-w-0 shrink overflow-hidden whitespace-nowrap text-meta [@container(min-width:30rem)]:inline-flex"><EntityIdPill shortId={row.serves} type="initiative" compact /></span>}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden [@container(max-width:44rem)]:flex-wrap [@container(max-width:44rem)]:pl-[30px] [@container(max-width:44rem)]:empty:hidden">
          {drivers.map((d, i) => (
            <span key={d.short_id} data-rail-start={i === 0 || undefined} className="flex min-w-[6rem] max-w-[13rem] shrink" title="Works most of this priority's milestones">
              <SessionChip s={d} className="w-full" />
            </span>
          ))}
          {show.plans && model.plan && <PlanChip plan={model.plan} className="shrink-[2]" />}
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
            {row.status !== "active" ? (
              <span className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>
            ) : finished ? (
              <button type="button" onClick={() => toast("Mark done: prototype only")} className="inline-flex h-6 items-center gap-1 rounded-full bg-sol-green/15 px-2.5 text-meta font-semibold tabular-nums text-sol-green hover:bg-sol-green/25">
                <Check className="size-3" strokeWidth={3} /> {d}/{t} · Mark done?
              </button>
            ) : t > 0 ? (
              <span className="flex items-center gap-1.5" title={`${d} of ${t} critical milestones done`}>
                <span className="flex gap-[2px]">
                  {Array.from({ length: t }, (_, i) => (
                    <i key={i} className={cn("block h-[7px] w-[7px] rounded-[1.5px]", i < d ? "bg-sol-green" : "bg-sol-text/15")} />
                  ))}
                </span>
                <span className="w-7 text-right text-meta tabular-nums text-sol-text-muted">{d}/{t}</span>
              </span>
            ) : null}
          </span>
        </span>
      </div>
      <span className={STRIP_CELL}><LabStrip counts={model.counts} landed={model.landed} todayIndex={todayIndex} levels={levels} size="head" /></span>
      <RowMenu label={`More for ${row.title}`} hoverGroup="head">
        <DropdownMenuItem onSelect={prototype("Mark done")}>Mark done</DropdownMenuItem>
        {row.mine && row.status === "active" && <DropdownMenuItem onSelect={() => writes.setAside(row.short_id)}>Set aside</DropdownMenuItem>}
        <DropdownMenuItem onSelect={prototype("Merge into")}>Merge into…</DropdownMenuItem>
        <DropdownMenuItem onSelect={prototype("Correct")}>Correct…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(window.location.origin + priorityHref(row.short_id)); toast("Link copied"); }}>Copy link</DropdownMenuItem>
      </RowMenu>
    </div>
  );
}

function RowMenu({ label, hoverGroup, children }: { label: string; hoverGroup: "head" | "line"; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "justify-self-end rounded p-1 text-sol-text-dim opacity-0 hover:bg-sol-bg-highlight hover:text-sol-text focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
            hoverGroup === "head" ? "group-hover/head:opacity-100" : "group-hover/line:opacity-100",
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
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
  // A covered line leaves its session slot to the rail, unless it has a session of its own besides the drivers.
  const own = drivers.length ? m.sessions.filter((s) => !drivers.some((d) => d.short_id === s.short_id)) : m.sessions;
  const [best, ...others] = own;
  const polish = step.tier === "polish";
  const chips: ReactNode[] = [];
  if (show.sessions && !step.done) {
    if (best) chips.push(<SessionChip key="s" s={best} className="min-w-[7rem]" />);
    else if (!covered && row.mine) {
      chips.push(
        <Link key="start" href={newSessionHref(row, step)} onClick={(e) => e.stopPropagation()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-sol-border px-2 text-meta text-sol-text-muted hover:border-sol-text-dim hover:text-sol-text">
          <Play className="size-2.5 fill-current" /> Start
        </Link>,
      );
    }
    if (others.length) chips.push(<OtherSessions key="o" others={others} now={now} />);
  }
  if (show.plans && m.plan) chips.push(<PlanChip key="p" plan={m.plan} />);
  if (show.tasks && m.tasks.length) {
    chips.push(...m.tasks.slice(0, 2).map((t) => <TaskChip key={t.short_id} task={t} />));
    if (m.tasks.length > 2) chips.push(<span key="tmore" className="shrink-0 text-meta text-sol-text-dim">+{m.tasks.length - 2}</span>);
  }
  if (show.prs) chips.push(...m.prs.map((p) => <PrChip key={`${p.repository}#${p.number}`} pr={p} />));
  if (show.branches) chips.push(...m.branches.map((b) => <BranchChip key={b} name={b} />));
  if (show.deploys) chips.push(...m.deploys.map((d) => <DeployChip key={d.short_id} d={d} now={now} />));
  return (
    <li data-lab-milestone={step.key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn(LAB_GRID, "group/line -mx-1.5 min-h-8 cursor-pointer rounded-control px-1.5 py-[3px] hover:bg-sol-bg-alt/60", open && "bg-sol-bg-alt/60")}
      >
        <div className={ROW_SPLIT}>
          <span className="flex min-w-0 items-center gap-2 pl-2 [@container(min-width:44rem)]:pl-[30px]">
            <MilestoneRing done={step.done} polish={polish} />
            {next && <span className="shrink-0 rounded-[4px] bg-sol-blue px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-sol-bg">Next</span>}
            <span title={step.title} className={cn("min-w-0 truncate text-ui", step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : polish ? "text-sol-text-muted" : "font-medium text-sol-text")}>
              {step.title}
            </span>
          </span>
          <span
            data-rail-tick={covered || undefined}
            className={cn(
              "flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1",
              "[@container(max-width:44rem)]:pl-[30px]",
              drivers.length > 0 && "[@container(min-width:44rem)]:pl-6",
              chips.length === 0 && "[@container(max-width:44rem)]:hidden",
            )}
          >
            {chips}
          </span>
        </div>
        <span className={STRIP_CELL}><LabStrip counts={m.counts} todayIndex={todayIndex} levels={levels} size="line" /></span>
        <RowMenu label={`More for ${step.title}`} hoverGroup="line">
          <DropdownMenuItem onSelect={prototype("Done")}>Done</DropdownMenuItem>
          <DropdownMenuItem onSelect={prototype("Rename")}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={prototype("Drop")}>Drop</DropdownMenuItem>
          {row.mine && (
            <DropdownMenuItem onSelect={() => writes.setStepTier(row.short_id, step.key, polish ? "critical" : "polish")}>
              {polish ? "Move to critical" : "Move to polish"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={prototype("Correct")}>Correct…</DropdownMenuItem>
        </RowMenu>
      </div>
      {open && <MilestoneDetail model={model} m={m} show={show} todayIndex={todayIndex} levels={levels} now={now} />}
    </li>
  );
}

function MilestoneRing({ done, polish }: { done: boolean; polish: boolean }) {
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

function MilestoneDetail({ model, m, show, todayIndex, levels, now }: { model: PriorityModel; m: MilestoneModel; show: ShowRefs; todayIndex: number; levels: number[]; now: number }) {
  const [openTypes, setOpenTypes] = useState<Record<TypeKey, boolean>>({ plans: show.plans, prs: show.prs, branches: show.branches, deploys: show.deploys, tasks: show.tasks });
  const toggle = (k: TypeKey) => setOpenTypes((o) => ({ ...o, [k]: !o[k] }));
  const plan = m.plan ?? model.plan;
  const planCount = (plan ? 1 : 0) + m.partOf.length;
  const head = "mb-1 mt-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
  return (
    <div data-lab-milestone-detail className="mb-2 ml-4 border-l border-sol-border/60 pl-3 [@container(min-width:44rem)]:ml-[52px]">
      <div className="pt-1">
        {planCount > 0 && (
          <TypeRow label="Plan" count={planCount} open={openTypes.plans} onToggle={() => toggle("plans")}>
            {plan && <PlanChip plan={plan} />}
            {m.partOf.map((p) => <PlanChip key={p._id} plan={p} prefix="Part of" className="max-w-[20rem]" />)}
            {m.partOf.length > 0 && <span className="text-meta text-sol-text-dim">{m.partOf.map((p) => `${p.size} tasks`).join(", ")}</span>}
          </TypeRow>
        )}
        {m.prs.length > 0 && (
          <TypeRow label="PRs" count={m.prs.length} open={openTypes.prs} onToggle={() => toggle("prs")}>
            {m.prs.map((p) => <PrChip key={`${p.repository}#${p.number}`} pr={p} />)}
          </TypeRow>
        )}
        {m.branches.length > 0 && (
          <TypeRow label="Branches" count={m.branches.length} open={openTypes.branches} onToggle={() => toggle("branches")}>
            {m.branches.map((b) => <BranchChip key={b} name={b} />)}
          </TypeRow>
        )}
        {m.deploys.length > 0 && (
          <TypeRow label="Deploys" count={m.deploys.length} open={openTypes.deploys} onToggle={() => toggle("deploys")}>
            {m.deploys.map((d) => <DeployChip key={d.short_id} d={d} now={now} />)}
          </TypeRow>
        )}
        {m.tasks.length > 0 && (
          <TypeRow label="Tasks" count={m.tasks.length} open={openTypes.tasks} onToggle={() => toggle("tasks")}>
            {m.tasks.map((t) => <TaskChip key={t.short_id} task={t} className="max-w-[24rem]" />)}
          </TypeRow>
        )}
      </div>
      {m.sessions.length > 0 && (
        <>
          <div className={head}>Sessions</div>
          <ul>
            {m.sessions.map((s) => (
              <li key={s.short_id} className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-3 py-0.5 [@container(min-width:44rem)]:grid-cols-[minmax(0,1fr)_52px_24px]">
                <span className="flex min-w-0 items-center gap-2">
                  <SessionChip s={s} className="max-w-[22rem]" />
                  <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">
                    {s.status && <span className={SESSION_STATUS[s.status].text}>{SESSION_STATUS[s.status].word}</span>}
                    {s.status && s.updated_at ? " · " : ""}
                    {s.updated_at ? ago(s.updated_at, now) : ""}
                  </span>
                  <WhyTags why={s.why} className="hidden [@container(min-width:30rem)]:flex" />
                </span>
                <span className={STRIP_CELL}><LabStrip counts={m.sessionCounts.get(s.short_id) ?? []} todayIndex={todayIndex} levels={levels} size="line" /></span>
                <span className="hidden [@container(min-width:44rem)]:block" />
              </li>
            ))}
          </ul>
        </>
      )}
      {planCount + m.prs.length + m.branches.length + m.deploys.length + m.tasks.length + m.sessions.length === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}
