"use client";
// Priorities lab (throwaway prototype, nothing ships): the redesigned List
// view of /priorities over the real rows. Filter bar, a ten-day momentum band,
// then each priority as a flat header and one line per open milestone, its
// best session, the rest as dots, its plan, and a strip whose days line up
// down the page.
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertTriangle, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityDetail, PriorityHistory, PriorityRow } from "@codecast/shared/contracts/priorities";
import { heatLevels } from "../../ActivityHeatmap";
import { EmptyState } from "../../ui/empty-state";
import { SkeletonRows } from "../../ui/skeleton";
import { PageFrame, PageHeader } from "../../ui/page-header";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityWrites, useSyncPriorities } from "../../../hooks/usePriorities";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { findEntityInStore } from "../../../lib/liveEntities";
import { ownerGroups } from "../../../lib/priorities";
import { useInboxStore } from "../../../store/inboxStore";
import { cn } from "../../../lib/utils";
import { sessionView, useSessionStates } from "./LabParts";
import { MomentumBand } from "./MomentumBand";
import { LAB_CSS } from "./labCss";
import { PriorityBlock, type PriorityModel } from "./PriorityBlock";
import {
  LAB_DAYS, alignCounts, connectedSessions, derivePlan, landedAt, landedByDay, lastDays, localDayKey, orderSessions, readFilters, sessionRank, writeFilters,
  type ConnectedRaw, type DerivedPlan, type LabFilters, type PlanOf, type ShowRefs, type TaskOf,
} from "./labModel";

const api = _api as any;
const CONTAINER = { containerType: "inline-size" } as CSSProperties;

export default function PrioritiesLab() {
  const workspace = useActiveWorkspaceKey();
  const feed = useSyncPriorities();
  const rows = usePriorities();
  const writes = usePriorityWrites(rows);
  const now = useCoarseNow(30_000);
  const history = useQueryNoThrow(
    api.priorities.history,
    workspace ? { workspace, days: LAB_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : "skip",
    { remember: true },
  ).data as PriorityHistory | undefined;

  const [filters, setFiltersState] = useState<LabFilters>(() => readFilters(typeof window === "undefined" ? "" : window.location.search));
  const setFilters = (f: LabFilters) => { setFiltersState(f); writeFilters(f); };

  const scoped = useMemo(() => rows.filter((r) => r.status !== "merged" && (!filters.mine || r.mine)), [rows, filters.mine]);
  const visible = useMemo(() => scoped.filter((r) => !filters.hideDone || r.status === "active"), [scoped, filters.hideDone]);

  // Every step's sessions, once each visible priority's `show` answered (a list row holds only its newest three).
  const [details, setDetails] = useState<Record<string, PriorityDetail>>({});
  const onDetail = useMemo(() => (id: string, d: PriorityDetail) => setDetails((m) => (m[id] === d ? m : { ...m, [id]: d })), []);

  const days = useMemo(() => {
    const local = lastDays(LAB_DAYS, now);
    return history?.days?.length === LAB_DAYS && history.days[LAB_DAYS - 1] === local[LAB_DAYS - 1] ? history.days : local;
  }, [history, now]);
  const todayIndex = days.indexOf(localDayKey(now));

  // Plans arrive through their own feeder; reading them here wakes the page when they land.
  const plans = useWorkspaceCollection<{ _id: string; short_id?: string; title?: string; progress?: { done: number; total: number }; session_ids?: string[] }>("plans");

  const taskOf = useMemo<TaskOf>(() => {
    const st = useInboxStore.getState() as any;
    return (id: string) => findEntityInStore(st, "task", id) as ReturnType<TaskOf>;
  }, [rows]);

  // Per milestone: its derived plan and every connected session (mapped, linked, via a task, via the plan).
  const connected = useMemo(() => {
    const st = useInboxStore.getState() as any;
    const planById = new Map(plans.map((p) => [p._id, p]));
    const planOf: PlanOf = (id) => planById.get(id) ?? st.plans?.[id];
    const out = new Map<string, { plan: DerivedPlan | null; raw: ConnectedRaw[] }>();
    for (const r of visible) {
      for (const s of r.steps) {
        const plan = derivePlan(s, taskOf, planOf);
        out.set(`${r.short_id}:${s.key}`, { plan, raw: connectedSessions(r, s, details[r.short_id], taskOf, plan) });
      }
    }
    return out;
  }, [visible, details, taskOf, plans]);
  const rawSessions = useMemo(() => new Map([...connected].map(([k, v]) => [k, v.raw])), [connected]);
  const allIds = useMemo(() => [...new Set([...rawSessions.values()].flat().map((s) => s.short_id))].sort(), [rawSessions]);
  const live = useSessionStates(allIds);

  const models = useMemo<PriorityModel[]>(() => {
    const lane = new Map((history?.lanes ?? []).map((l) => [l.short_id ?? l.key, l]));
    return visible.map((row) => {
      const milestones = row.steps.map((step) => {
        // Direct connections (mapped, linked, via a task) rank first; a session reached only through the plan
        // is never the milestone's best one: on a big plan it would be every milestone's.
        const all = (rawSessions.get(`${row.short_id}:${step.key}`) ?? []).map((s) => sessionView(s, live));
        const direct = orderSessions(all.filter((s) => s.why.some((w) => w !== "via plan")));
        const sessions = [...direct, ...orderSessions(all.filter((s) => s.why.every((w) => w === "via plan")))];
        const sessionCounts = new Map(sessions.map((s) => [s.short_id, alignCounts(history, days, history?.sessions?.[s.short_id])]));
        const counts = days.map((_, i) => sessions.reduce((n, s) => n + (sessionCounts.get(s.short_id)?.[i] ?? 0), 0));
        return { step, sessions, directCount: direct.length, plan: connected.get(`${row.short_id}:${step.key}`)?.plan ?? null, counts, sessionCounts };
      });
      const landedDays = new Set(row.steps.map((s) => landedAt(s, taskOf)).filter((t): t is number => !!t).map(localDayKey));
      return {
        row,
        counts: alignCounts(history, days, lane.get(row.short_id)?.counts),
        landed: days.map((d) => landedDays.has(d)),
        milestones,
      };
    });
  }, [visible, rawSessions, connected, live, history, days, taskOf]);

  // Exactly one "Next": the first open critical milestone, in rank order, of the viewer's own, that nothing is already moving or asking on.
  const nextKey = useMemo(() => {
    const mine = models.filter((m) => m.row.mine && m.row.status === "active").sort((a, b) => (a.row.rank ?? 1e9) - (b.row.rank ?? 1e9));
    for (const pm of mine) {
      for (const m of pm.milestones) {
        if (m.step.done || m.step.tier !== "critical") continue;
        const best = m.directCount ? m.sessions[0] : undefined;
        if (best && sessionRank(best) <= 1) continue;
        return `${pm.row.short_id}:${m.step.key}`;
      }
    }
    return null;
  }, [models]);

  const headLevels = useMemo(() => heatLevels(models.flatMap((m) => m.counts)), [models]);
  const lineLevels = useMemo(() => heatLevels(models.flatMap((m) => m.milestones.flatMap((x) => x.counts))), [models]);
  const landed = useMemo(() => landedByDay(scoped, days, taskOf), [scoped, days, taskOf]);
  const typed = useMemo(
    () => alignCounts(history, days, (history?.lanes ?? []).filter((l) => !l.owner).reduce<number[]>((acc, l) => l.counts.map((n, i) => n + (acc[i] ?? 0)), [])),
    [history, days],
  );

  let body;
  if (rows.length === 0 && feed.error) {
    body = <EmptyState icon={AlertTriangle} title="Priorities didn't load" action={{ label: "Try again", onClick: feed.retry }} />;
  } else if (rows.length === 0) {
    body = <SkeletonRows rows={6} className="pt-2" rowClassName="h-8" />;
  } else {
    const groups = ownerGroups(visible);
    const showOwners = !filters.mine;
    body = (
      <>
        <MomentumBand days={days} landed={landed} typed={typed} todayIndex={todayIndex} />
        {groups.map((g) => (
          <section key={g.user_id} className={cn(showOwners && "mb-6")}>
            {showOwners && <h2 className="mb-1 border-b border-sol-border/60 pb-1.5 text-ui font-semibold text-sol-text">{g.mine ? "You" : g.owner || "Teammate"}</h2>}
            <ol>
              {[...g.active, ...g.past].map((r) => {
                const model = models.find((m) => m.row.short_id === r.short_id);
                return model ? (
                  <PriorityBlock key={r.short_id} model={model} nextKey={nextKey} show={filters.show} hideDone={filters.hideDone} todayIndex={todayIndex} headLevels={headLevels} lineLevels={lineLevels} writes={writes} now={now} />
                ) : null;
              })}
            </ol>
          </section>
        ))}
        {visible.map((r) => <DetailProbe key={r.short_id} shortId={r.short_id} onData={onDetail} />)}
      </>
    );
  }

  return (
    <PageFrame
      header={<PageHeader legacy={<h1 className="px-4 pt-6 text-title font-semibold text-sol-text">Priorities</h1>} title="Priorities" icon={Target} count={visible.length || null} />}
      legacyColumn="mx-auto w-full max-w-[1080px]"
      column="mx-auto w-full max-w-[1080px] px-4 pb-16 pt-3"
    >
      <div data-priorities-lab style={CONTAINER}>
        <style>{LAB_CSS}</style>
        <FilterBar filters={filters} onChange={setFilters} />
        {body}
      </div>
    </PageFrame>
  );
}

function DetailProbe({ shortId, onData }: { shortId: string; onData: (id: string, d: PriorityDetail) => void }) {
  const d = useQueryNoThrow(api.priorities.show, { short_id: shortId }, { remember: true }).data as PriorityDetail | null | undefined;
  useEffect(() => { if (d) onData(shortId, d); }, [d, shortId, onData]);
  return null;
}

const SHOW_LABELS: Array<[keyof ShowRefs, string]> = [["sessions", "Sessions"], ["plans", "Plans"], ["tasks", "Tasks"], ["prs", "PRs"]];

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-control border px-2.5 text-ui transition-colors",
        on ? "border-sol-blue/40 bg-sol-blue/10 font-medium text-sol-blue" : "border-sol-border/70 text-sol-text-muted hover:border-sol-border hover:text-sol-text",
      )}
    >
      {children}
    </button>
  );
}

function FilterBar({ filters, onChange }: { filters: LabFilters; onChange: (f: LabFilters) => void }) {
  return (
    <div data-lab-filters className="-mx-4 mb-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
      <Toggle on={filters.mine} onClick={() => onChange({ ...filters, mine: !filters.mine })}>Mine</Toggle>
      <Toggle on={filters.hideDone} onClick={() => onChange({ ...filters, hideDone: !filters.hideDone })}>Hide done</Toggle>
      <span className="mx-1.5 h-4 w-px shrink-0 bg-sol-border" />
      <span className="mr-0.5 shrink-0 text-meta text-sol-text-dim">Show</span>
      {SHOW_LABELS.map(([k, label]) => (
        <Toggle key={k} on={filters.show[k]} onClick={() => onChange({ ...filters, show: { ...filters.show, [k]: !filters.show[k] } })}>{label}</Toggle>
      ))}
    </div>
  );
}
