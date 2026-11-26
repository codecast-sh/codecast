// Priorities lab (throwaway prototype): one priority's own page (`?view=pri-60`).
// What it is and whose, where it stands over thirty days, every milestone on
// either side of the line, every session by milestone, what is linked, and the
// person's corrections to the pass.
import { useMemo, useState } from "react";
import { ArrowLeft, Check, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import { EntityIdPill } from "../../EntityIdPill";
import { ShareControl } from "../../ShareControl";
import { heatLevels } from "../../ActivityHeatmap";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { priorityHref, type PriorityWrites } from "../../../lib/priorities";
import { cn } from "../../../lib/utils";
import { CorrectPopover, LabStrip, SessionChip } from "./LabParts";
import { alignCounts, lastDays, localDayKey, type ShowRefs } from "./labModel";
import { CriticalMeter, MilestoneRing, PriorityMenuItems, RowMenu, SessionLine, StartButton, TypeRows, type MilestoneModel, type PriorityModel } from "./PriorityBlock";

const api = _api as any;
const PAGE_DAYS = 30;

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function PriorityPage({ model, workspace, writes, show, now, onBack }: {
  model: PriorityModel;
  workspace: string | null;
  writes: PriorityWrites;
  show: ShowRefs;
  now: number;
  onBack: () => void;
}) {
  const { row } = model;
  const history = useQueryNoThrow(
    api.priorities.history,
    workspace ? { workspace, days: PAGE_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : "skip",
    { remember: true },
  ).data as PriorityHistory | undefined;
  const days = useMemo(() => lastDays(PAGE_DAYS, now), [now]);
  const counts = alignCounts(history, days, history?.lanes.find((l) => l.short_id === row.short_id)?.counts);
  const levels = useMemo(() => heatLevels(counts), [counts]);
  const landedDays = new Set(model.milestones.map((m) => m.landedAt).filter((t): t is number => !!t).map(localDayKey));
  const landed = days.map((d) => landedDays.has(d));
  const typedTotal = counts.reduce((a, b) => a + b, 0);

  const critical = model.milestones.filter((m) => m.step.tier === "critical");
  const polish = model.milestones.filter((m) => m.step.tier === "polish");
  const sessionsSeen = new Set<string>();
  const byMilestone = model.milestones
    .map((m) => ({ m, sessions: m.sessions.filter((s) => !sessionsSeen.has(s.short_id) && (sessionsSeen.add(s.short_id), true)) }))
    .filter((g) => g.sessions.length > 0);
  const all = <T,>(pick: (m: MilestoneModel) => T[], key: (x: T) => string) => {
    const out = new Map<string, T>();
    for (const m of model.milestones) for (const x of pick(m)) out.set(key(x), x);
    return [...out.values()];
  };
  const prs = all((m) => m.prs, (p) => `${p.repository}#${p.number}`);
  const branches = all((m) => m.branches, (b) => b);
  const deploys = all((m) => m.deploys, (d) => d.short_id);
  const partOf = all((m) => m.partOf, (p) => p._id);
  const ownPlans = all((m) => (m.plan ? [m.plan] : []), (p) => p._id);
  const plan = model.plan ?? ownPlans[0] ?? null;

  const section = "mt-7";
  const head = "mb-2 flex items-baseline gap-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
  return (
    <article data-lab-page={row.short_id} className="mx-auto max-w-[760px] pb-10">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 rounded px-1 py-0.5 text-meta text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text">
        <ArrowLeft className="size-3.5" /> Priorities
      </button>
      <header className="flex items-start gap-3">
        <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sol-orange/10 text-sol-orange"><Target className="size-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-tight text-sol-text">{row.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-sol-text-dim">
            <span className="font-mono">{row.short_id}</span>
            <span aria-hidden>·</span>
            <span>{row.mine ? "You" : row.owner}</span>
            {row.rank != null && <><span aria-hidden>·</span><span>Rank #{row.rank}</span></>}
            {row.serves && <><span aria-hidden>·</span><span className="whitespace-nowrap [&_*]:!whitespace-nowrap"><EntityIdPill shortId={row.serves} type="initiative" compact /></span></>}
            <span className="ml-1"><CriticalMeter row={row} /></span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ShareControl label="priority" path={priorityHref(row.short_id)} />
          <RowMenu label={`More for ${row.title}`} hoverGroup="page" subject={row.title}>
            {(correct) => <PriorityMenuItems row={row} writes={writes} onCorrect={correct} />}
          </RowMenu>
        </div>
      </header>
      {row.summary && <p className="mt-4 max-w-[62ch] text-body leading-relaxed text-sol-text-muted">{row.summary}</p>}

      <section className="mt-5 rounded-lg border border-sol-border/60 px-4 pb-3 pt-3">
        <div className="flex items-baseline justify-between text-meta text-sol-text-dim">
          <span>Last {PAGE_DAYS} days</span>
          <span className="tabular-nums">{typedTotal} typed · {landed.filter(Boolean).length} {landed.filter(Boolean).length === 1 ? "day" : "days"} a milestone landed</span>
        </div>
        <div className="mt-2"><LabStrip counts={counts} landed={landed} todayIndex={days.length - 1} levels={levels} size="page" /></div>
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-sol-text-dim" style={{ width: PAGE_DAYS * 14 - 4 }}>
          <span>{shortDate(new Date(`${days[0]}T12:00:00`).getTime())}</span>
          <span className="font-semibold text-sol-text">Today</span>
        </div>
      </section>

      <section className={section}>
        <h2 className={head}>Critical path <span className="font-normal normal-case tracking-normal tabular-nums">{critical.filter((m) => m.step.done).length}/{critical.length}</span></h2>
        <MilestoneList model={model} list={critical} />
      </section>
      {polish.length > 0 && (
        <section className={section}>
          <h2 className={head}>Polish <span className="font-normal normal-case tracking-normal tabular-nums">{polish.filter((m) => m.step.done).length}/{polish.length}</span></h2>
          <MilestoneList model={model} list={polish} />
        </section>
      )}

      {byMilestone.length > 0 && (
        <section className={section}>
          <h2 className={head}>Sessions <span className="font-normal normal-case tracking-normal tabular-nums">{sessionsSeen.size}</span></h2>
          <div className="space-y-3">
            {byMilestone.map(({ m, sessions }) => (
              <div key={m.step.key}>
                <div className="mb-1 flex items-center gap-2 text-meta text-sol-text-muted">
                  <MilestoneRing done={m.step.done} polish={m.step.tier === "polish"} />
                  <span className="truncate">{m.step.title}</span>
                </div>
                <ul className="pl-[22px]">{sessions.map((s) => <SessionLine key={s.short_id} s={s} todayIndex={-1} levels={[]} now={now} />)}</ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {(plan || partOf.length + prs.length + branches.length + deploys.length > 0) && (
        <section className={section}>
          <h2 className={head}>Linked</h2>
          <TypeRows plan={plan} partOf={partOf} prs={prs} branches={branches} deploys={deploys} tasks={[]} show={{ ...show, plans: true, prs: true, branches: true, deploys: true }} now={now} />
        </section>
      )}

      <Corrections subject={row.title} />
    </article>
  );
}

function MilestoneList({ model, list }: { model: PriorityModel; list: MilestoneModel[] }) {
  const { row } = model;
  return (
    <ul className="divide-y divide-sol-border/40 rounded-lg border border-sol-border/60">
      {list.map((m) => {
        const session = m.sessions[0] ?? (m.coveredByDriver ? model.drivers[0] : undefined);
        return (
          <li key={m.step.key} className="flex min-h-10 items-center gap-2.5 px-3 py-1.5">
            <MilestoneRing done={m.step.done} polish={m.step.tier === "polish"} />
            <span className={cn("min-w-0 flex-1 truncate text-ui", m.step.done ? "text-sol-text-muted" : "font-medium text-sol-text")}>{m.step.title}</span>
            {m.step.done ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-meta tabular-nums text-sol-text-dim">
                <Check className="size-3 text-sol-green" strokeWidth={2.5} />
                {m.landedAt ? `Landed ${shortDate(m.landedAt)}` : "Done"}
              </span>
            ) : session ? (
              <SessionChip s={session} className="max-w-[16rem]" />
            ) : (
              <StartButton row={row} step={m.step} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Corrections({ subject }: { subject: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-7">
      <h2 className="mb-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Your corrections</h2>
      <div className="flex items-center justify-center rounded-lg border border-dashed border-sol-border/70 py-5">
        <CorrectPopover open={open} onOpenChange={setOpen} subject={subject}>
          <button type="button" onClick={() => setOpen(true)} className="inline-flex h-7 items-center rounded-control px-3 text-meta text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text">
            Correct…
          </button>
        </CorrectPopover>
      </div>
    </section>
  );
}
