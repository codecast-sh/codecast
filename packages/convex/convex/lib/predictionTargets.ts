// Where a predicted effect is read, and how small a change it can see there
// (ct-96177 follow-up, shared/contracts/predictedEffect.ts). A target is a
// goal metric (`in-N:key`), a metric series (`mw-N`) or an environment
// (`env:<product>/<name>`). The level and detectable change come from what the
// goal's own surfaces already read: a metric's windowed reading and its noise
// model (metricStanding), an env's latest attempt. A leaf with no function
// definitions: predictions.ts and the goals brief (goals.ts) read it.
import type { Doc } from "../_generated/dataModel";
import { metricNumber, metricReading, type InitiativeMetric, type MetricSeries } from "@codecast/shared/contracts/initiative";
import { metricPeriodMs, parseMetricWindow, shareScale, windowSlotTimes } from "@codecast/shared/contracts/metricStanding";
import { envMde, readMde, targetKind, PREDICTION_READ, type PredictionTarget } from "@codecast/shared/contracts/predictedEffect";
import { seriesLookup, watchIn } from "./metricSeries";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** The span of a read on each side of ship when the prediction states no time: the window a read is capped at. */
export const DEFAULT_READ_SPAN_MS = PREDICTION_READ.max_window_days * DAY;

type Metric = InitiativeMetric & { noise?: string; window?: string };
type MetricRow = { metrics?: InitiativeMetric[]; scoreboard?: Record<string, any> };

/** A target's level and what a read over `spanMs` a side can detect there, with the goal it serves and the series a read follows. */
export type TargetSense = { kind: PredictionTarget; name: string; level: number | null; mde: number | null; goal?: string; series?: string; metric?: Metric };

/** How long one value of a metric counts over, as its band reads it (a week when its words and window name none). */
export const metricPeriodOf = (m: Pick<Metric, "name" | "window">, series?: Pick<MetricSeries, "name" | "unit"> | null): number =>
  metricPeriodMs(`${m.name} ${series?.name ?? ""} ${series?.unit ?? ""}`, parseMetricWindow(m.window) ?? { count: 1, unit: "w", ms: WEEK });

/**
 * A metric's level and detectable change over a read of `spanMs` a side, from
 * the reading its goal or project already shows. A metric with no noise model
 * takes its series' own spread across recent periods as one (seriesSpread).
 */
export async function metricSense(ctx: { db: any }, workspace: string, m: Metric, row: MetricRow, lookup: (ref: string) => MetricSeries | undefined, spanMs: number): Promise<{ level: number | null; mde: number | null }> {
  const series = m.series ? lookup(m.series) ?? null : null;
  const r = metricReading(m, row.scoreboard?.[m.key], series, lookup);
  const level = r.band?.mean ?? metricNumber(r.value);
  const period = metricPeriodOf(m, series);
  const noise = m.noise ?? (m.series ? await seriesSpread(ctx, workspace, m.series, period) : null);
  const band = r.band ?? (noise && level !== null ? { mean: level, mde: null } : null);
  return { level, mde: readMde(band, noise, period, spanMs, shareScale(series?.unit, m.target, level === null ? [] : [level])) };
}

const SPREAD_PERIODS = 8;
/**
 * A series' spread from period to period, as an A/A noise model (`aa:<sd>`):
 * the value nearest each of its last eight period marks, one indexed read
 * each. It holds real drift as well as noise, so what it says a read detects
 * errs large. Null with fewer than four periods of history or no spread.
 */
export async function seriesSpread(ctx: { db: any }, workspace: string, ref: string, periodMs: number): Promise<string | null> {
  const watch = await watchIn(ctx, workspace, ref);
  const latest = watch?.points[watch.points.length - 1]?.at;
  if (!watch || latest === undefined) return null;
  const values: number[] = [];
  for (const t of windowSlotTimes(latest, periodMs, SPREAD_PERIODS)) {
    const p = await ctx.db.query("metric_points").withIndex("by_watch_at", (q: any) => q.eq("watch_id", watch._id).lte("at", t)).order("desc").first();
    const near = p && t - p.at < periodMs / 2 ? p : watch.points.find((x: { at: number }) => Math.abs(x.at - t) < periodMs / 2);
    if (near) values.push(near.value);
  }
  if (values.length < 4) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
  return sd > 0 ? `aa:${sd.toFixed(6)}` : null;
}

/** An env's level and detectable change, from its recent attempts: the latest's mean, and the first paired interval or A/A spread among them. */
export function envSense(attempts: ReadonlyArray<Pick<Doc<"env_attempts">, "mean" | "ci95" | "paired_ci95" | "noise">>): { level: number | null; mde: number | null } {
  const sized = attempts.find((a) => a.paired_ci95?.length === 2) ?? attempts.find((a) => a.noise) ?? attempts[0];
  return { level: attempts[0]?.mean ?? null, mde: envMde(sized) };
}

export const recentAttempts = (ctx: { db: any }, workspace: string, env: string, take = 5): Promise<Doc<"env_attempts">[]> =>
  ctx.db.query("env_attempts").withIndex("by_workspace_env", (q: any) => q.eq("workspace", workspace).eq("env", env)).order("desc").take(take);

const goalsOf = (ctx: { db: any }, workspace: string): Promise<Doc<"initiatives">[]> =>
  ctx.db.query("initiatives").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(200);

/**
 * Resolve a target in a workspace: what it is called, its level, what a read of
 * `spanMs` a side detects there, and the goal it serves. A series reads the
 * noise model of the goal or project metric that names it, and serves that
 * goal (or the goal carrying that project); an env serves the goal that lists
 * it. An error names what is missing.
 */
export async function targetSense(ctx: { db: any }, workspace: string, ref: string, spanMs: number): Promise<TargetSense | { error: string }> {
  const kind = targetKind(ref);
  if (!kind) return { error: `"${ref}" is not a goal metric, a metric series or an environment` };
  if (kind === "metric") {
    const [sid, key] = ref.split(":");
    const goal: Doc<"initiatives"> | null = await ctx.db.query("initiatives").withIndex("by_short_id", (q: any) => q.eq("short_id", sid)).first();
    if (!goal || goal.workspace !== workspace) return { error: `No goal ${sid} in this workspace (cast goals lists them)` };
    const m = (goal.metrics ?? []).find((x: Metric) => x.key === key) as Metric | undefined;
    if (!m) return { error: `${goal.short_id} has no metric "${key}"; its metrics: ${(goal.metrics ?? []).map((x: Metric) => x.key).join(", ") || "none"}` };
    const lookup = await seriesLookup(ctx, workspace, [goal]);
    return { kind, name: m.name, goal: goal.short_id, ...(m.series ? { series: m.series } : {}), metric: m, ...(await metricSense(ctx, workspace, m, goal, lookup, spanMs)) };
  }
  const goals = await goalsOf(ctx, workspace);
  if (kind === "env") {
    const env = ref.slice(4);
    const attempts = await recentAttempts(ctx, workspace, env);
    const goal = goals.find((g: any) => (g.envs ?? []).some((e: { env: string }) => e.env === env));
    if (!attempts.length && !goal) return { error: `No environment ${env} in this workspace: no goal lists it and it has no attempts (cast env ls)` };
    return { kind, name: env, ...(goal ? { goal: goal.short_id } : {}), ...envSense(attempts) };
  }
  const watch = await watchIn(ctx, workspace, ref);
  if (!watch) return { error: `No metric watch ${ref} in this workspace (cast metrics ls lists them)` };
  const named = (row: MetricRow) => (row.metrics ?? []).filter((m) => m.series === ref) as Metric[];
  const direct = goals.find((g) => named(g).length);
  const projects: Doc<"projects">[] = direct ? [] : await ctx.db.query("projects").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).take(500);
  const project = projects.find((p: any) => named(p).length);
  const owner: MetricRow | undefined = direct ?? project;
  const metric = owner ? named(owner).find((m) => m.noise) ?? named(owner)[0] : undefined;
  const goal = direct ?? (project ? goals.find((g) => g.project_ids.some((id) => String(id) === String(project._id))) : undefined);
  const base = { kind, name: watch.name, series: ref, ...(goal ? { goal: goal.short_id } : {}) };
  const lone: Metric = metric ?? { key: ref, name: watch.name, target: "", series: ref };
  const lookup = owner ? await seriesLookup(ctx, workspace, [owner]) : (r: string) => (r === ref ? { short_id: ref, name: watch.name, unit: watch.unit ?? null, points: watch.points } : undefined);
  return { ...base, ...(metric ? { metric } : {}), ...(await metricSense(ctx, workspace, lone, owner ?? {}, lookup, spanMs)) };
}
