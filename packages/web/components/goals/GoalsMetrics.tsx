"use client";
// /goals?view=metrics: the goals read through their numbers. A count of every
// number by standing up top, then each goal (in the document's order) with a
// chart per number, its own and those of the projects it carries: the values
// over the chosen range against the target, drawn as a flat line or, for a
// dated trajectory, the path it sets (contracts/metricStanding targetAt),
// carried past today to where the trajectory is heading. Goals with no number
// are listed last, each opening its page.
//
// Live numbers read their watch's values for the range from the store
// (opsWatchSeries, fed here at card size); a reported number reads its
// score_history. The standing on each card is the same reading every other
// surface shows (metricReadings).
import { useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatSeriesValue, metricAgainst, metricNumber, metricReadings, metricTrends, type InitiativeMetric, type InitiativeRow, type InitiativeScore, type MetricReading, type MetricSeries, type MetricStanding, type MetricTrend } from "@codecast/shared/contracts/initiative";
import { parseMetricTarget, pointDay, standingWord, targetAt, type MetricTarget } from "@codecast/shared/contracts/metricStanding";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMetricSeries } from "../../hooks/useMetricSeries";
import { useSyncSeriesMany, useWatchSeriesMap } from "../../hooks/useSyncOpsMetrics";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { initiativeEnded } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { SegmentedToggle } from "../SegmentedToggle";
import { HealthChip, MetricStandingDot, STANDING_COLOR, TrendGlyph } from "../initiatives/InitiativeAtoms";
import { useCompanyDoc } from "../company/useCompanyDoc";
import type { DocGoal } from "../company/companyModel";
import { OpsChart } from "../ops/chart/OpsChart";
import { alpha, axisBase, esc, resolveColor, swatch, tipRow, tooltipBase, type ChartTheme } from "../ops/chart/chartTheme";
import { rangeMs } from "../ops/metricSeries";
import { opsHref } from "../ops/opsPaths";
import type { MetricRange } from "../ops/metricModel";

const DIM = "var(--sol-text-dim)";
const MUTED = "var(--sol-text-muted)";
const RULE = "color-mix(in srgb, var(--sol-border) 30%, transparent)";
const DAY = 86_400_000;
const RANGES = [{ key: "7d", label: "7d" }, { key: "30d", label: "30d" }, { key: "all", label: "All" }] as const;
type GoalRange = (typeof RANGES)[number]["key"];
const STANDINGS: MetricStanding[] = ["behind", "within_noise", "met", "unknown"];
const STANDING_LABEL: Record<MetricStanding, string> = { met: "Met", within_noise: "Within noise", behind: "Behind", unknown: "Unread" };

type Pt = { at: number; value: number };
/** One number as a card draws it: its reading, trend, the values to plot and where it comes from. */
type Card = { id: string; reading: MetricReading; trend?: MetricTrend; points: Pt[]; from?: { title: string; href: string } };
type Section = { goal: DocGoal; row: InitiativeRow; depth: number; cards: Card[] };

const projectMetricsSig = (p: ProjectItem) => `${p.status}|${p.title}|${JSON.stringify(p.metrics ?? null)}`;

/** The values a card plots: the watch's answer for the range, else the series' own history, else the reports. */
function pointsOf(m: InitiativeMetric, series: MetricSeries | undefined, ranged: Pt[] | undefined, history: InitiativeScore[] | undefined): Pt[] {
  if (m.series) {
    if (ranged?.length) return ranged;
    const all = [...(series?.history ?? []), ...(series?.points ?? [])].sort((a, b) => a.at - b.at);
    return all.filter((p, i) => i === 0 || p.at !== all[i - 1].at);
  }
  return (history ?? []).map((s) => ({ at: s.observed_at, value: metricNumber(s.value) })).filter((p): p is Pt => p.value !== null).sort((a, b) => a.at - b.at);
}

export function GoalsMetrics() {
  useSyncOrgTreeFeeder();
  useSyncProjects();
  const router = useRouter();
  const search = useSearchParams();
  const range: GoalRange = (RANGES.find((r) => r.key === search.get("range"))?.key) ?? "30d";
  const setRange = (next: string) => {
    const p = new URLSearchParams(search.toString());
    if (next === "30d") p.delete("range"); else p.set("range", next);
    router.replace(`/goals?${p.toString()}`);
  };
  const { doc } = useCompanyDoc();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectMetricsSig);
  const { lookup, watches } = useMetricSeries();
  const now = useCoarseNow(60_000);

  // Every watch a goal or a project reads, fed for the range at card size.
  const byRef = useMemo(() => new Map(watches.map((w) => [w.short_id, w._id])), [watches]);
  const projectById = useMemo(() => new Map(projects.map((p) => [String(p._id), p])), [projects]);
  const goalRows = useMemo(() => doc.goals.flatMap(function rows(g): InitiativeRow[] { return [...(g.row ? [g.row] : []), ...g.goals.flatMap(rows)]; }), [doc.goals]);
  const watchIds = useMemo(() => {
    const refs = [...goalRows.flatMap((r) => r.metrics ?? []), ...projects.flatMap((p) => p.metrics ?? [])].map((m) => m.series).filter((s): s is string => !!s);
    return [...new Set(refs.map((r) => byRef.get(r)).filter((id): id is string => !!id))].sort();
  }, [goalRows, projects, byRef]);
  useSyncSeriesMany(watchIds, range as MetricRange);
  const ranged = useWatchSeriesMap(range as MetricRange);

  const { sections, bare } = useMemo(() => {
    const valuesFor = (m: InitiativeMetric) => {
      const id = m.series ? byRef.get(m.series) : undefined;
      const r = id ? ranged.get(id) : undefined;
      return r?.points.map((p) => ({ at: p.at, value: p.value }));
    };
    const out: Section[] = [];
    const none: DocGoal[] = [];
    const walk = (g: DocGoal, depth: number) => {
      const row = g.row;
      if (row && !initiativeEnded(row.status)) {
        const readings = metricReadings(row, lookup);
        const trends = metricTrends(row, lookup);
        const cards: Card[] = readings.map((r) => ({ id: `${row._id}:${r.key}`, reading: r, trend: trends[r.key], points: pointsOf(r, r.series ? lookup(r.series) : undefined, valuesFor(r), row.score_history?.[r.key]) }));
        for (const dp of g.projects) {
          const p = projectById.get(dp.id);
          if (!p?.metrics?.length || dp.ghost) continue;
          const pt = metricTrends({ metrics: p.metrics }, lookup);
          for (const r of metricReadings({ metrics: p.metrics }, lookup)) {
            cards.push({ id: `${p._id}:${r.key}`, reading: r, trend: pt[r.key], points: pointsOf(r, r.series ? lookup(r.series) : undefined, valuesFor(r), undefined), from: { title: p.title, href: objectHref("project", dp.short_id ?? dp.id) } });
          }
        }
        if (cards.length) out.push({ goal: g, row, depth, cards }); else none.push(g);
      }
      for (const k of g.goals) walk(k, depth + 1);
    };
    for (const g of doc.goals) walk(g, 0);
    return { sections: out, bare: none };
  }, [doc.goals, lookup, ranged, byRef, projectById]);

  const tally = useMemo(() => {
    const t: Record<MetricStanding, number> = { met: 0, within_noise: 0, behind: 0, unknown: 0 };
    for (const s of sections) for (const c of s.cards) t[c.reading.standing]++;
    return t;
  }, [sections]);
  const total = STANDINGS.reduce((n, k) => n + tally[k], 0);
  const span = rangeMs(range as MetricRange);

  return (
    <div className="h-full overflow-y-auto" data-goals-metrics>
      <div className="mx-auto max-w-[1180px] px-6 pb-24">
        <header className="sticky top-0 z-[5] -mx-6 flex flex-wrap items-center gap-x-6 gap-y-2 bg-sol-bg px-6 pb-3 pt-4 pr-[300px] max-sm:pr-6">
          <h1 className="text-[15px] font-semibold" style={{ color: "var(--sol-text)" }}>Metrics</h1>
          <div className="flex items-center gap-4 text-[12px] tabular-nums" data-metrics-tally>
            <span style={{ color: MUTED }}><b className="font-semibold" style={{ color: "var(--sol-text)" }}>{total}</b> tracked</span>
            {STANDINGS.filter((k) => tally[k] > 0).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5" style={{ color: MUTED }} data-tally={k}>
                <MetricStandingDot standing={k} />
                <b className="font-semibold" style={{ color: k === "unknown" ? MUTED : STANDING_COLOR[k] }}>{tally[k]}</b>
                {STANDING_LABEL[k].toLowerCase()}
              </span>
            ))}
          </div>
          <SegmentedToggle size="sm" value={range} onChange={setRange} items={RANGES.map((r) => ({ key: r.key, label: r.label }))} />
        </header>

        {sections.length === 0 && (
          <div className="mt-16 text-center text-[13px]" style={{ color: DIM }}>
            No goal has a number yet. <Link href="/goals" className="underline" style={{ color: MUTED }}>Give one a number in the document</Link>
          </div>
        )}

        {sections.map((s) => (
          <section key={s.row._id} className="mt-8" data-metrics-goal={s.row._id}>
            <div className="flex items-baseline gap-3 border-b pb-2" style={{ borderColor: RULE, paddingLeft: s.depth > 1 ? 16 * (s.depth - 1) : 0 }}>
              <Link href={objectHref("initiative", s.row.short_id ?? s.row._id)} className={cn("min-w-0 truncate font-semibold no-underline hover:underline", s.depth <= 1 ? "text-[15px]" : "text-[13.5px]")} style={{ color: "var(--sol-text)" }}>{s.goal.title}</Link>
              {s.row.health && <HealthChip health={s.row.health} at={s.row.health_at} now={now} lower />}
              {s.goal.owner?.name && <span className="text-meta" style={{ color: DIM }}>{s.goal.owner.name}</span>}
              {s.row.target_date && <span className="ml-auto text-meta tabular-nums" style={{ color: DIM }}>due {pointDay(s.row.target_date)}</span>}
            </div>
            <div className="mt-3 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
              {s.cards.map((c) => <MetricCard key={c.id} card={c} now={now} span={span} />)}
            </div>
          </section>
        ))}

        {bare.length > 0 && (
          <section className="mt-10" data-metrics-unmeasured>
            <div className="border-b pb-2 text-[12px]" style={{ borderColor: RULE, color: MUTED }}>No number <span className="tabular-nums" style={{ color: DIM }}>{bare.length}</span></div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
              {bare.map((g) => (
                <Link key={g.id} href={objectHref("initiative", g.short_id ?? g.id)} className="text-[12.5px] no-underline hover:underline" style={{ color: MUTED }}>{g.title}</Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one number

function MetricCard({ card, now, span }: { card: Card; now: number; span: number | null }) {
  const { reading: r, trend, points, from } = card;
  const target = useMemo(() => (r.target_unread ? null : parseMetricTarget(r.target)), [r.target, r.target_unread]);
  const traj = r.trajectory;
  const unit = r.unit ?? target?.unit ?? null;
  const word = standingWord(r.standing, traj);
  const head = (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <MetricStandingDot standing={r.standing} />
        <span className="truncate" style={{ color: "var(--sol-text)" }}>{r.name}</span>
        {r.guardrail && <span className="rounded px-1 text-[10px] uppercase tracking-wide" style={{ color: DIM, border: `1px solid ${RULE}` }}>guardrail</span>}
        <span className="flex-1" />
        {word && <span className="whitespace-nowrap text-meta" style={{ color: r.standing === "unknown" ? DIM : STANDING_COLOR[r.standing] }}>{word}</span>}
      </div>
      <div className="mt-1.5 flex min-w-0 items-baseline gap-2">
        <span className="text-[22px] font-semibold leading-none tabular-nums tracking-tight" style={{ color: r.value === null ? DIM : "var(--sol-text)" }}>{r.value ?? "none yet"}</span>
        <span className="truncate text-[12px] tabular-nums" style={{ color: DIM }}>
          {traj ? `target ${formatSeriesValue(traj.in_force, traj.unit)} now, ${formatSeriesValue(traj.final.value, traj.unit)} by ${pointDay(traj.final.at)}` : r.value === null ? metricAgainst(r) : `target ${r.target}`}
        </span>
        {trend && <TrendGlyph trend={trend} />}
      </div>
    </>
  );
  return (
    <div className="min-w-0 rounded-xl border px-3 pb-1.5 pt-2.5" style={{ borderColor: RULE }} data-metric-card={r.key} data-metric-standing={r.standing}>
      {r.series ? <Link href={opsHref.metric(r.series)} className="block no-underline" title={`Open ${r.series}`}>{head}</Link> : head}
      <GoalMetricChart points={points} target={target} standing={r.standing} unit={unit} now={now} span={span} />
      <div className="mt-0.5 flex items-center gap-2 text-[11px]" style={{ color: DIM }}>
        {from ? <Link href={from.href} className="truncate no-underline hover:underline" style={{ color: DIM }}>{from.title}</Link> : <span>{r.live ? r.series : "reported"}</span>}
        <span className="flex-1" />
        {r.observed_at && <span className="tabular-nums">{r.live ? "read" : "reported"} {pointDay(r.observed_at)}</span>}
      </div>
    </div>
  );
}

/** The values against the target over the range: a flat dashed line for a number, the path a trajectory sets, carried past today toward its last point. */
function GoalMetricChart({ points, target, standing, unit, now, span }: { points: Pt[]; target: MetricTarget | null; standing: MetricStanding; unit: string | null; now: number; span: number | null }) {
  const win = useMemo(() => {
    const first = points[0]?.at ?? now - 30 * DAY;
    const from = span ? now - span : Math.min(first, now - DAY);
    const width = now - from;
    const last = target?.kind === "trajectory" ? target.points[target.points.length - 1]!.at : now;
    return { from, to: Math.max(now, Math.min(last, now + width / 3)) };
  }, [points, target, span, now]);
  const shown = useMemo(() => points.filter((p) => p.at >= win.from && p.at <= win.to), [points, win]);
  const line = useMemo((): Pt[] => {
    if (!target) return [];
    const inner = target.kind === "trajectory" ? target.points.filter((p) => p.at > win.from && p.at < win.to) : [];
    return [{ at: win.from, value: targetAt(target, win.from) }, ...inner, { at: win.to, value: targetAt(target, win.to) }];
  }, [target, win]);

  if (shown.length === 0) {
    return <div className="my-2 flex h-9 items-center justify-center rounded-md text-[12px]" style={{ color: DIM, background: "color-mix(in srgb, var(--sol-border) 10%, transparent)" }}>{points.length ? "No values in this range" : "No values yet"}</div>;
  }
  const option = (t: ChartTheme) => {
    const ink = standing === "unknown" ? t.blue : resolveColor(STANDING_COLOR[standing]);
    const values = [...shown.map((p) => p.value), ...line.map((p) => p.value)];
    const lo = Math.min(...values), hi = Math.max(...values);
    // A flat stretch keeps some room around it, so a small wobble never reads as a cliff.
    const spread = Math.max(hi - lo, Math.abs(hi) * 0.2, 1e-6);
    const pad = spread * 0.15;
    const fmt = (v: number) => formatSeriesValue(v, unit);
    return {
      animation: false,
      grid: { left: 4, right: 10, top: 10, bottom: 4, containLabel: true },
      xAxis: { type: "time" as const, min: win.from, max: win.to, minInterval: (win.to - win.from) / 5, ...axisBase(t), splitLine: { show: false }, axisLabel: { ...axisBase(t).axisLabel, hideOverlap: true, formatter: (v: number) => pointDay(v) } },
      yAxis: { type: "value" as const, min: lo >= 0 && lo - pad < 0 ? 0 : lo - pad, max: hi + pad, splitNumber: 3, ...axisBase(t), axisLabel: { ...axisBase(t).axisLabel, showMinLabel: false, showMaxLabel: false, formatter: (v: number) => fmt(v) } },
      tooltip: {
        ...tooltipBase(t), trigger: "axis" as const, axisPointer: { type: "line" as const, lineStyle: { color: t.line } },
        formatter: (ps: any) => {
          const at = Number((Array.isArray(ps) ? ps[0] : ps)?.value?.[0] ?? (Array.isArray(ps) ? ps[0] : ps)?.axisValue);
          const near = shown.reduce<Pt | null>((b, p) => (!b || Math.abs(p.at - at) < Math.abs(b.at - at) ? p : b), null);
          const rows = [near && Math.abs(near.at - at) < (win.to - win.from) / 20 ? tipRow(t, swatch(ink), "value", fmt(near.value)) : "", target ? tipRow(t, swatch(t.muted, true), "target", fmt(targetAt(target, at))) : ""];
          return `<div style="color:${t.dim};font-size:11px">${esc(new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }))}</div>${rows.join("")}`;
        },
      },
      series: [
        {
          id: "value", type: "line" as const, data: shown.map((p) => [p.at, p.value]), showSymbol: shown.length < 16, symbolSize: 4, itemStyle: { color: ink },
          lineStyle: { width: 1.6, color: ink }, areaStyle: { color: { type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(ink, 0.16) }, { offset: 1, color: alpha(ink, 0) }] } },
          markLine: win.to > now + 1000 ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { color: t.line, type: "solid" as const, width: 1 }, data: [{ xAxis: now }] } : undefined,
        },
        { id: "target", type: "line" as const, data: line.map((p) => [p.at, p.value]), showSymbol: false, silent: true, lineStyle: { width: 1.2, type: "dashed" as const, color: t.muted } },
      ],
    };
  };
  return <OpsChart option={option} deps={[shown, line, win, standing, unit, now]} height={132} ariaLabel="Values against the target over time" />;
}
