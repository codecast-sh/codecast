// Priorities lab (throwaway prototype): one priority as a flat header row and
// one line per open milestone under it. Everything the lines draw is derived
// by the page (PrioritiesLab) and handed in.
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, ChevronRight, MoreHorizontal, Play } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { EntityIdPill } from "../../EntityIdPill";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { SESSION_STATUS } from "../../../lib/sessionStatus";
import { newSessionHref, pastBadge, priorityHref, type PriorityWrites } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { LAB_GRID, LabStrip, OtherSessions, SessionPill, STRIP_CELL, WhyTags } from "./LabParts";
import { ago, type DerivedPlan, type SessionView, type ShowRefs } from "./labModel";

export type MilestoneModel = {
  step: PriorityStep;
  /** Direct connections first (ordered best first), then the plan-only ones. */
  sessions: SessionView[];
  directCount: number;
  plan: DerivedPlan | null;
  counts: number[];
  sessionCounts: Map<string, number[]>;
};

export type PriorityModel = {
  row: PriorityRow;
  counts: number[];
  landed: boolean[];
  milestones: MilestoneModel[];
};

const prototype = (what: string) => () => toast(`${what}: prototype only`);

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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const past = row.status !== "active";
  const open = model.milestones.filter((m) => !m.step.done);
  const critical = open.filter((m) => m.step.tier === "critical");
  const polish = open.filter((m) => m.step.tier === "polish");
  const done = model.milestones.filter((m) => m.step.done);
  const line = (m: MilestoneModel) => (
    <MilestoneLine
      key={m.step.key}
      row={row}
      m={m}
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
  return (
    <li data-lab-priority={row.short_id} className={cn("border-b border-sol-border/50 py-2.5 last:border-b-0", past && "opacity-70")}>
      <PriorityHeader model={model} todayIndex={todayIndex} levels={headLevels} writes={writes} />
      {(open.length > 0 || done.length > 0) && (
        <ul className="mt-1">
          {critical.map(line)}
          {polish.length > 0 && (
            <li aria-hidden className="ml-8 mt-1.5 flex items-center gap-2 text-mark uppercase tracking-wide text-sol-text-dim/80">
              Polish <span className="h-px flex-1 bg-sol-border/50" />
            </li>
          )}
          {polish.map(line)}
          {done.length > 0 && (hideDone && !doneOpen ? (
            <li>
              <button type="button" onClick={() => setDoneOpen(true)} className="ml-8 mt-0.5 inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-meta text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text-muted">
                <Check className="size-3 text-sol-green" strokeWidth={2.5} /> {done.length} done
              </button>
            </li>
          ) : done.map(line))}
        </ul>
      )}
    </li>
  );
}

function PriorityHeader({ model, todayIndex, levels, writes }: { model: PriorityModel; todayIndex: number; levels: number[]; writes: PriorityWrites }) {
  const { row } = model;
  const { critical_done: d, critical_total: t } = row.counts;
  const finished = row.status === "active" && t > 0 && d === t;
  return (
    <div className={cn(LAB_GRID, "group/head min-h-8")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="w-5 shrink-0 text-right text-ui font-semibold tabular-nums text-sol-text-dim">{row.rank ?? ""}</span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Link href={priorityHref(row.short_id)} className="min-w-0 truncate text-body font-semibold text-sol-text hover:underline decoration-sol-text-dim/50 underline-offset-2" title={row.summary || row.title}>
            {row.title}
          </Link>
          <span className="hidden shrink-0 font-mono text-meta text-sol-text-dim [@container(min-width:30rem)]:inline">{row.short_id}</span>
          {row.serves && <span className="hidden min-w-0 shrink overflow-hidden whitespace-nowrap text-meta [@container(min-width:30rem)]:inline-flex"><EntityIdPill shortId={row.serves} type="initiative" compact /></span>}
        </span>
        {row.status !== "active" ? (
          <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>
        ) : finished ? (
          <button type="button" onClick={() => toast("Mark done: prototype only")} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-sol-green/15 px-2.5 text-meta font-semibold tabular-nums text-sol-green hover:bg-sol-green/25">
            <Check className="size-3" strokeWidth={3} /> {d}/{t} · Mark done?
          </button>
        ) : t > 0 ? (
          <span className="flex shrink-0 items-center gap-2" title={`${d} of ${t} critical milestones done`}>
            <span className="flex w-[64px] justify-end gap-[2px]">
              {Array.from({ length: t }, (_, i) => (
                <i key={i} className={cn("block h-[7px] min-w-[3px] max-w-[10px] flex-1 rounded-[1.5px]", i < d ? "bg-sol-green" : "bg-sol-text/10")} />
              ))}
            </span>
            <span className="w-7 text-right text-meta tabular-nums text-sol-text-muted">{d}/{t}</span>
          </span>
        ) : null}
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

function RowMenu({ label, hoverGroup, children }: { label: string; hoverGroup: "head" | "line"; children: React.ReactNode }) {
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

function MilestoneLine({ row, m, next, show, todayIndex, levels, open, onToggle, writes, now }: {
  row: PriorityRow;
  m: MilestoneModel;
  next: boolean;
  show: ShowRefs;
  todayIndex: number;
  levels: number[];
  open: boolean;
  onToggle: () => void;
  writes: PriorityWrites;
  now: number;
}) {
  const { step } = m;
  const best = m.directCount ? m.sessions[0] : undefined;
  const others = m.sessions.slice(m.directCount ? 1 : 0, m.directCount);
  const viaPlan = m.sessions.slice(m.directCount);
  const tasks = step.refs.filter((r) => r.kind === "task");
  const code = step.refs.filter((r) => r.kind === "pr" || r.kind === "commit");
  const polish = step.tier === "polish";
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-8 [@container(min-width:44rem)]:flex-nowrap">
          <span className="flex min-w-0 max-w-full items-center gap-2 [@container(max-width:44rem)]:basis-full [@container(min-width:44rem)]:max-w-[58%] [@container(min-width:44rem)]:shrink-0">
            <MilestoneRing done={step.done} polish={polish} />
            {next && <span className="shrink-0 rounded-[4px] bg-sol-blue px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-wide text-sol-bg">Next</span>}
            <span
              title={step.title}
              className={cn(
                "min-w-0 truncate text-ui",
                step.done ? "text-sol-text-dim line-through decoration-sol-text-dim/40" : polish ? "text-sol-text-muted" : "font-medium text-sol-text",
              )}
            >
              {step.title}
            </span>
          </span>
          <span className="flex min-w-0 shrink items-center gap-1.5 [@container(max-width:44rem)]:pl-6">
            {show.sessions && !step.done && (best
              ? <SessionPill s={best} className="min-w-[8.5rem]" />
              : row.mine && (
                <Link href={newSessionHref(row, step)} onClick={(e) => e.stopPropagation()} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-dashed border-sol-border px-2 text-meta text-sol-blue hover:border-sol-blue/60">
                  <Play className="size-2.5 fill-current" /> Start
                </Link>
              ))}
            {show.sessions && !step.done && <OtherSessions others={others} viaPlan={viaPlan} plan={m.plan?.short_id} now={now} />}
            {show.plans && m.plan && (
              <Link
                href={`/plans/${m.plan.short_id}`}
                onClick={(e) => e.stopPropagation()}
                title={`${m.plan.short_id} · ${m.plan.title}`}
                className="inline-flex h-6 min-w-[5rem] max-w-[16rem] shrink-[3] items-center gap-1.5 rounded-control px-1.5 text-meta tabular-nums text-sol-violet hover:bg-sol-violet/10"
              >
                <span className="min-w-0 truncate">{m.plan.title || m.plan.short_id}</span>
                <span className="shrink-0 text-sol-text-dim">{m.plan.done}/{m.plan.total}</span>
              </Link>
            )}
            {show.tasks && tasks.slice(0, 2).map((t) => <span key={t.id} className="shrink-0 text-meta" onClick={(e) => e.stopPropagation()}><EntityIdPill shortId={t.id} type="task" compact /></span>)}
            {show.tasks && tasks.length > 2 && <span className="shrink-0 text-meta text-sol-text-dim">+{tasks.length - 2}</span>}
            {show.prs && code.map((c) => <span key={c.id} className="shrink-0 text-meta" onClick={(e) => e.stopPropagation()}><EntityIdPill shortId={c.id} type={c.kind as "pr" | "commit"} certain compact /></span>)}
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
      {open && <MilestoneDetail m={m} todayIndex={todayIndex} levels={levels} now={now} />}
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

function MilestoneDetail({ m, todayIndex, levels, now }: { m: MilestoneModel; todayIndex: number; levels: number[]; now: number }) {
  const tasks = m.step.refs.filter((r) => r.kind === "task");
  const code = m.step.refs.filter((r) => r.kind === "pr" || r.kind === "commit");
  const head = "mb-1 mt-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
  return (
    <div data-lab-milestone-detail className="mb-2 ml-[52px] border-l border-sol-border/60 pl-3">
      {tasks.length > 0 && (
        <>
          <div className={head}>Tasks</div>
          <ul className="space-y-0.5">
            {tasks.map((t) => <li key={t.id} className="flex min-w-0 text-ui"><EntityIdPill shortId={t.id} type="task" wide /></li>)}
          </ul>
        </>
      )}
      {m.sessions.length > 0 && (
        <>
          <div className={head}>Sessions</div>
          <ul>
            {m.sessions.map((s) => (
              <li key={s.short_id} className="grid grid-cols-[minmax(0,1fr)] items-center gap-x-4 py-0.5 [@container(min-width:44rem)]:grid-cols-[minmax(0,1fr)_220px_24px]">
                <span className="flex min-w-0 items-center gap-2">
                  <SessionPill s={s} className="max-w-[24rem]" />
                  <span className="shrink-0 whitespace-nowrap text-meta text-sol-text-dim">
                    {s.status && <span className={SESSION_STATUS[s.status].text}>{SESSION_STATUS[s.status].word}</span>}
                    {s.status && s.updated_at ? " · " : ""}
                    {s.updated_at ? ago(s.updated_at, now) : ""}
                  </span>
                  <WhyTags why={s.why} className="hidden [@container(min-width:30rem)]:flex" />
                </span>
                <span className="hidden [@container(min-width:44rem)]:block"><LabStrip counts={m.sessionCounts.get(s.short_id) ?? []} todayIndex={todayIndex} levels={levels} size="line" /></span>
                <span className="hidden [@container(min-width:44rem)]:block" />
              </li>
            ))}
          </ul>
        </>
      )}
      {code.length > 0 && (
        <>
          <div className={head}>Pull requests and commits</div>
          <ul className="space-y-0.5">
            {code.map((c) => <li key={c.id} className="flex min-w-0 text-ui"><EntityIdPill shortId={c.id} type={c.kind as "pr" | "commit"} certain wide /></li>)}
          </ul>
        </>
      )}
      {tasks.length === 0 && m.sessions.length === 0 && code.length === 0 && <div className="py-1 text-meta text-sol-text-dim">Nothing linked yet</div>}
    </div>
  );
}

