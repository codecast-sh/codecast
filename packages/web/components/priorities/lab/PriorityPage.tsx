// Priorities lab (throwaway prototype): one priority's own page (`?view=pri-60`).
// Title and rank, whose and what it serves, what to do next (and what waits
// on the person), then every milestone with its sessions and links, which
// open in place like the list's, and the thirty-day record once it is old
// enough to have one.
import { useMemo, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, PencilLine, Target } from "lucide-react";
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
import { ActionButton, type NextAction } from "./nextAction";
import { CriticalMeter, MilestoneDetail, MilestoneRing, milestoneChips, PriorityMenuItems, RowMenu, TypeRows, type MilestoneModel, type PriorityModel } from "./PriorityBlock";
import { WaitingRow, type WaitingItem } from "./Waiting";

const api = _api as any;
const PAGE_DAYS = 30;
/** Younger than this, a thirty-day record is mostly empty: the page says when it started instead. */
const CHART_MIN_AGE_MS = 7 * 86_400_000;

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function PriorityPage({ model, action, waiting, workspace, writes, show, now, onBack, ownerCount }: {
  model: PriorityModel;
  action: NextAction | null;
  waiting: WaitingItem[];
  workspace: string | null;
  writes: PriorityWrites;
  show: ShowRefs;
  now: number;
  onBack: () => void;
  ownerCount: number;
}) {
  const { row } = model;
  const [correcting, setCorrecting] = useState(false);
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
  const oldEnough = now - row.first_seen_at >= CHART_MIN_AGE_MS;

  const critical = model.milestones.filter((m) => m.step.tier === "critical");
  const polish = model.milestones.filter((m) => m.step.tier === "polish");
  const all = <T,>(pick: (m: MilestoneModel) => T[], key: (x: T) => string) => {
    const out = new Map<string, T>();
    for (const m of model.milestones) for (const x of pick(m)) out.set(key(x), x);
    return [...out.values()];
  };
  const prs = all((m) => m.prs, (p) => `${p.repository}#${p.number}`);
  const branches = all((m) => m.branches, (b) => b);
  const deploys = all((m) => m.deploys, (d) => d.short_id);
  const partOf = all((m) => m.partOf, (p) => p._id);
  const plan = model.plan ?? all((m) => (m.plan ? [m.plan] : []), (p) => p._id)[0] ?? null;
  const rank = row.rank ?? 0;
  const ranked = row.mine && row.status === "active" && rank > 0;

  const head = "mb-2 flex items-baseline gap-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";
  return (
    <article data-lab-page={row.short_id} className="mx-auto max-w-[780px] pb-10">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 rounded px-1 py-0.5 text-meta text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text">
        <ArrowLeft className="size-3.5" /> Priorities
      </button>
      <header className="flex items-start gap-3">
        <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-sol-orange/10 text-sol-orange"><Target className="size-[18px]" /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-tight text-sol-text">{row.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-sol-text-dim">
            {ranked && (
              <span className="inline-flex items-center rounded-control border border-sol-border">
                <button type="button" aria-label="Move up" disabled={rank <= 1} onClick={() => writes.rank(row.short_id, rank - 1)} className="flex size-7 items-center justify-center text-sol-text-muted hover:text-sol-text disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                <span className="px-1 text-ui font-semibold tabular-nums text-sol-text">#{rank}</span>
                <button type="button" aria-label="Move down" disabled={rank >= ownerCount} onClick={() => writes.rank(row.short_id, rank + 1)} className="flex size-7 items-center justify-center text-sol-text-muted hover:text-sol-text disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
              </span>
            )}
            <CriticalMeter row={row} />
            <span aria-hidden>·</span>
            <span>{row.mine ? "You" : row.owner}</span>
            {row.serves && <><span aria-hidden>·</span><span className="whitespace-nowrap [&_*]:!whitespace-nowrap"><EntityIdPill shortId={row.serves} type="initiative" compact /></span></>}
            <span aria-hidden>·</span>
            <span>Started {shortDate(row.first_seen_at)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{row.short_id}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CorrectPopover open={correcting} onOpenChange={setCorrecting} subject={row.title}>
            <button type="button" onClick={() => setCorrecting(true)} className="inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-meta text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text">
              <PencilLine className="size-3.5" /> Correct…
            </button>
          </CorrectPopover>
          <ShareControl label="priority" path={priorityHref(row.short_id)} />
          <RowMenu label={`More for ${row.title}`} hoverGroup="page" subject={row.title} className="inline-flex">
            {(correct) => <PriorityMenuItems row={row} writes={writes} onCorrect={correct} ownerCount={ownerCount} />}
          </RowMenu>
        </div>
      </header>

      {action && (
        <section data-lab-page-next className="mt-5 rounded-lg border border-sol-border/70 bg-sol-bg-alt/50 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-sol-text-dim">Next</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <MilestoneRing done={false} polish={false} />
              <span className="min-w-0 truncate text-body font-medium text-sol-text">{action.m.step.title}</span>
            </span>
            <span className="flex items-center gap-1.5">
              {action.session && <SessionChip s={action.session} hideState={action.kind === "needs_you"} className="max-w-[14rem]" />}
              <ActionButton row={row} step={action.m.step} action={action} />
            </span>
          </div>
        </section>
      )}
      {waiting.length > 0 && (
        <section className="mt-3 overflow-hidden rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06]">
          <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-sol-text-muted">Waiting on you</div>
          <ul className="divide-y divide-sol-yellow/20">{waiting.map((w) => <WaitingRow key={w.key} item={w} showRank={false} />)}</ul>
        </section>
      )}

      {row.summary && <p className="mt-5 max-w-[64ch] text-body leading-relaxed text-sol-text-muted">{row.summary}</p>}

      {oldEnough && (
        <section className="mt-5">
          <div className="flex items-baseline justify-between text-meta text-sol-text-dim">
            <span>Last {PAGE_DAYS} days</span>
            <span className="tabular-nums">{counts.reduce((a, b) => a + b, 0)} typed</span>
          </div>
          <div className="mt-2"><LabStrip counts={counts} landed={landed} todayIndex={days.length - 1} levels={levels} size="page" /></div>
        </section>
      )}

      <section className="mt-7">
        <h2 className={head}>Critical path <span className="font-normal normal-case tracking-normal tabular-nums">{critical.filter((m) => m.step.done).length}/{critical.length}</span></h2>
        <MilestoneList model={model} list={critical} action={action} show={show} now={now} />
      </section>
      {polish.length > 0 && (
        <section className="mt-7">
          <h2 className={head}>Polish <span className="font-normal normal-case tracking-normal tabular-nums">{polish.filter((m) => m.step.done).length}/{polish.length}</span></h2>
          <MilestoneList model={model} list={polish} action={null} show={show} now={now} />
        </section>
      )}
      {(plan || partOf.length + prs.length + branches.length + deploys.length > 0) && (
        <section className="mt-7">
          <h2 className={head}>Linked</h2>
          <TypeRows plan={plan} partOf={partOf} prs={prs} branches={branches} deploys={deploys} tasks={[]} show={{ ...show, plans: true, prs: true, branches: true, deploys: true }} now={now} />
        </section>
      )}
    </article>
  );
}

/** Every milestone with its chips (the next one with its button); a row opens in place to its sessions and links. */
function MilestoneList({ model, list, action, show, now }: { model: PriorityModel; list: MilestoneModel[]; action: NextAction | null; show: ShowRefs; now: number }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-sol-border/40 rounded-lg border border-sol-border/60">
      {list.map((m) => {
        const open = openKey === m.step.key;
        const chips = m.step.done ? [] : milestoneChips({ model, m, drivers: [], action: action?.m === m ? action : null, show: { ...show, sessions: true }, now });
        return (
          <li key={m.step.key}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : m.step.key)}
              onKeyDown={(e) => { if (e.key === "Enter") setOpenKey(open ? null : m.step.key); }}
              className={cn("flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 py-2 hover:bg-sol-bg-alt/50", open && "bg-sol-bg-alt/50")}
            >
              <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
                <MilestoneRing done={m.step.done} polish={m.step.tier === "polish"} />
                <span className={cn("min-w-0 truncate text-ui", m.step.done ? "text-sol-text-muted" : "font-medium text-sol-text")}>{m.step.title}</span>
              </span>
              {m.step.done ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-meta tabular-nums text-sol-text-dim">
                  <Check className="size-3 text-sol-green" strokeWidth={2.5} />
                  {m.landedAt ? `Landed ${shortDate(m.landedAt)}` : "Done"}
                </span>
              ) : (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">{chips}</span>
              )}
            </div>
            {open && <div className="px-3 pb-2"><MilestoneDetail model={model} m={m} show={show} now={now} /></div>}
          </li>
        );
      })}
    </ul>
  );
}
