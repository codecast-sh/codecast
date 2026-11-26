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
import { usePriorityWrites } from "../../../hooks/usePriorities";
import { useSyncCollection } from "../../../hooks/useSyncCollection";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { findEntityInStore } from "../../../lib/liveEntities";
import { listRows, ownerGroups, prioritySig } from "../../../lib/priorities";
import { useInboxStore } from "../../../store/inboxStore";
import { cn } from "../../../lib/utils";
import { prefixIndex, sessionView, useSessionStates } from "./LabParts";
import { MomentumBand } from "./MomentumBand";
import { LAB_CSS } from "./labCss";
import { PriorityBlock, type MilestoneModel, type PriorityModel } from "./PriorityBlock";
import {
  LAB_DAYS, alignCounts, attributePlans, connectedSessions, landedAt, landedByDay, lastDays, localDayKey, orderSessions, readFilters, sessionRank, writeFilters,
  type ConnectedRaw, type DeployInfo, type LabFilters, type PlanOf, type PlanRow, type PrInfo, type ShowRefs, type TaskInfo, type TaskOf, type TaskRow,
} from "./labModel";

const api = _api as any;
const DEFAULT_BRANCHES = new Set(["main", "master", "HEAD", "develop"]);
const CONTAINER = { containerType: "inline-size" } as CSSProperties;

export default function PrioritiesLab() {
  // `?ws=team:…` pins the lab to one workspace without switching the app's active one (screenshots of Union while you sit elsewhere).
  const pinned = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("ws");
  const active = useActiveWorkspaceKey();
  const workspace = pinned ?? active;
  const feed = useSyncCollection("priorities", api.priorities.list, workspace ? { workspace } : "skip", { select: listRows });
  const rows = useWorkspaceCollection<PriorityRow>("priorities", prioritySig, workspace);
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
  const plans = useWorkspaceCollection<PlanRow>("plans", undefined, workspace);

  const taskOf = useMemo<TaskOf>(() => {
    const st = useInboxStore.getState() as any;
    return (id: string) => findEntityInStore(st, "task", id) as TaskRow | undefined;
  }, [rows]);

  // Per priority: which plan is its own and which are its milestones' (labModel attributePlans).
  const attribution = useMemo(() => {
    const st = useInboxStore.getState() as any;
    const planById = new Map(plans.map((p) => [p._id, p]));
    const planOf: PlanOf = (id) => planById.get(id) ?? st.plans?.[id];
    return new Map(visible.map((r) => [r.short_id, attributePlans(r.steps, taskOf, planOf)]));
  }, [visible, taskOf, plans]);

  // Per milestone: every directly connected session (mapped, linked, via a task).
  const rawSessions = useMemo(() => {
    const out = new Map<string, ConnectedRaw[]>();
    for (const r of visible) for (const s of r.steps) out.set(`${r.short_id}:${s.key}`, connectedSessions(r, s, details[r.short_id], taskOf));
    return out;
  }, [visible, details, taskOf]);
  const allIds = useMemo(() => [...new Set([...rawSessions.values()].flat().map((s) => s.short_id))].sort(), [rawSessions]);
  const live = useSessionStates(allIds);

  const models = useMemo<PriorityModel[]>(() => {
    const st = useInboxStore.getState() as any;
    const sessionsByPrefix = prefixIndex(st.sessions);
    const prByKey = new Map<string, any>();
    for (const pr of Object.values(st.pullRequests ?? {}) as any[]) prByKey.set(`${String(pr.repository).toLowerCase()}#${pr.number}`, pr);
    const deploys = Object.values(st.teamDeploys ?? {}) as any[];
    const lane = new Map((history?.lanes ?? []).map((l) => [l.short_id ?? l.key, l]));
    return visible.map((row) => {
      const plansHere = attribution.get(row.short_id);
      const milestones = row.steps.map((step): MilestoneModel => {
        const sessions = orderSessions((rawSessions.get(`${row.short_id}:${step.key}`) ?? []).map((s) => sessionView(s, live)));
        const sessionCounts = new Map(sessions.map((s) => [s.short_id, alignCounts(history, days, history?.sessions?.[s.short_id])]));
        const counts = days.map((_, i) => sessions.reduce((n, s) => n + (sessionCounts.get(s.short_id)?.[i] ?? 0), 0));
        const ids = new Set(sessions.map((s) => s.short_id));
        const taskIds = step.refs.filter((r) => r.kind === "task").map((r) => r.id);
        const tasks: TaskInfo[] = taskIds.map((id) => {
          const t = taskOf(id);
          return { short_id: id, title: t?.title ?? "", done: t?.status === "done" };
        });
        // Branches: the ones its own sessions work on, never the default branch.
        const branches = [...new Set(sessions.map((s) => {
          const r = sessionsByPrefix.get(s.short_id);
          return (r?.worktree_branch || r?.git_branch || "") as string;
        }).filter((b) => b && !DEFAULT_BRANCHES.has(b)))];
        // Deploys that shipped its tasks or its sessions' commits, newest first, one per target.
        const mine = deploys.filter((d) =>
          (d.tasks ?? []).some((t: any) => taskIds.includes(t.short_id)) ||
          (d.sessions ?? []).some((x: any) => ids.has(String(x.short_id ?? x.conversation_id ?? "").slice(0, 7))) ||
          (d.commit_rows ?? []).some((c: any) => c.conversation_id && ids.has(String(c.conversation_id).slice(0, 7))),
        ).map((d) => ({ short_id: d.short_id, target: d.target ?? "deploy", status: d.status ?? "", at: d.live_at ?? d.finished_at ?? d.created_at ?? 0 }))
          .sort((x, y) => y.at - x.at);
        const deployInfos: DeployInfo[] = [];
        for (const d of mine) if (!deployInfos.some((x) => x.target === d.target)) deployInfos.push(d);
        // Pull requests: refs the milestone names, and those its sessions' shipped commits squash-merged as "(#N)".
        const prKeys = new Set<string>();
        for (const r of step.refs) if (r.kind === "pr") prKeys.add(r.id.toLowerCase());
        for (const d of deploys) for (const c of d.commit_rows ?? []) {
          if (!c.conversation_id || !ids.has(String(c.conversation_id).slice(0, 7))) continue;
          const m = /\(#(\d+)\)\s*$/.exec(c.subject ?? "");
          if (m) prKeys.add(`${String(d.repository).toLowerCase()}#${m[1]}`);
        }
        const prs: PrInfo[] = [...prKeys].map((k) => prByKey.get(k)).filter(Boolean)
          .map((pr: any) => ({ repository: pr.repository, number: pr.number, title: pr.title ?? "", state: pr.state ?? "open" }));
        const planned = plansHere?.steps.get(step.key);
        return { step, sessions, counts, sessionCounts, plan: planned?.plan ?? null, partOf: planned?.partOf ?? [], tasks, prs, branches, deploys: deployInfos, coveredByDriver: false };
      });
      // A session bound across at least half the open milestones drives the priority: shown once on its header (at most two).
      const open = milestones.filter((m) => !m.step.done);
      const reach = new Map<string, number>();
      for (const m of open) for (const s of m.sessions) reach.set(s.short_id, (reach.get(s.short_id) ?? 0) + 1);
      const driverIds = open.length >= 2
        ? [...reach.entries()].filter(([, n]) => n >= 2 && n * 2 >= open.length).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id)
        : [];
      const drivers = driverIds.map((id) => open.flatMap((m) => m.sessions).find((s) => s.short_id === id)!).filter(Boolean);
      for (const m of milestones) if (!m.step.done && m.sessions.some((s) => driverIds.includes(s.short_id))) m.coveredByDriver = true;
      const landedDays = new Set(row.steps.map((s) => landedAt(s, taskOf)).filter((t): t is number => !!t).map(localDayKey));
      return {
        row,
        counts: alignCounts(history, days, lane.get(row.short_id)?.counts),
        landed: days.map((d) => landedDays.has(d)),
        milestones,
        plan: plansHere?.priority ?? null,
        drivers,
      };
    });
  }, [visible, rawSessions, attribution, live, history, days, taskOf]);

  // Exactly one "Next": the first open critical milestone, in rank order, of the viewer's own, that nothing is
  // already moving on: its session (its own best, else the priority's driver) is not working, asking or parked on a wake.
  const nextKey = useMemo(() => {
    const mine = models.filter((m) => m.row.mine && m.row.status === "active").sort((a, b) => (a.row.rank ?? 1e9) - (b.row.rank ?? 1e9));
    for (const pm of mine) {
      for (const m of pm.milestones) {
        if (m.step.done || m.step.tier !== "critical") continue;
        const own = m.sessions.find((s) => !pm.drivers.some((d) => d.short_id === s.short_id));
        const best = own ?? (m.coveredByDriver ? orderSessions(pm.drivers)[0] : undefined);
        if (best && sessionRank(best) <= 2) continue;
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
        <FilterBar filters={filters} onChange={setFilters} />
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
      column="mx-auto w-full max-w-[1080px] px-3 pb-16 pt-3 sm:px-4"
    >
      <div data-priorities-lab style={CONTAINER}>
        <style>{LAB_CSS}</style>
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

const SHOW_LABELS: Array<[keyof ShowRefs, string]> = [["sessions", "Sessions"], ["plans", "Plans"], ["tasks", "Tasks"], ["prs", "PRs"], ["branches", "Branches"], ["deploys", "Deploys"]];

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
    <div data-lab-filters className="-mx-3 mb-3 flex items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] sm:-mx-4 sm:px-4">
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
