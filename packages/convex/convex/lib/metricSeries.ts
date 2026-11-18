// The live series a goal's or a project's numbers read (contracts/initiative
// InitiativeMetric.series): metric watches named by short id, held to the
// row's own workspace. One validator for the stored metric shape (initiatives
// and projects share it), one check a write passes, and one lookup every
// reader (the role card, `cast brief`, the org scope view) builds its
// readings from, so a role and the page read the same value.
import { v } from "convex/values";
import { INITIATIVE_METRICS_MAX, metricKeyOf, type InitiativeMetric, type MetricSeries } from "@codecast/shared/contracts/initiative";
import { definitionOf, metricDenominatorRef, ofVersion, metricWindowNoiseError, parseMetricTarget, TRAJECTORY_TARGET_MAX, seriesPool, SLOT_TOLERANCE, windowPlan, windowSamples, windowSlotTimes } from "@codecast/shared/contracts/metricStanding";

export const metricValidator = v.object({ key: v.string(), name: v.string(), target: v.string(), series: v.optional(v.string()), guardrail: v.optional(v.boolean()), window: v.optional(v.string()), noise: v.optional(v.string()) });
export const metricArgValidator = v.object({ key: v.optional(v.string()), name: v.string(), target: v.string(), series: v.optional(v.union(v.string(), v.null())), guardrail: v.optional(v.boolean()), window: v.optional(v.union(v.string(), v.null())), noise: v.optional(v.union(v.string(), v.null())) });
export type MetricArg = { key?: string; name: string; target: string; series?: string | null; guardrail?: boolean; window?: string | null; noise?: string | null };

const clean = (text: string, max: number) => text.trim().slice(0, max);
const SERIES_REF = /^mw-\d+$/;

/** A list of metrics as a write gives it, checked and keyed: a name and a target each, a series named by its short id, at most INITIATIVE_METRICS_MAX. */
export function cleanMetrics(raw: MetricArg[]): InitiativeMetric[] {
  const metrics: InitiativeMetric[] = [];
  for (const m of raw) {
    const name = clean(String(m.name ?? ""), 80);
    // A dated trajectory reads whole (contracts/metricStanding parseMetricTarget); any other target keeps the short cap.
    const target = clean(String(m.target ?? ""), parseMetricTarget(String(m.target ?? ""))?.kind === "trajectory" ? TRAJECTORY_TARGET_MAX : 40);
    const key = metricKeyOf(m.key?.trim() || name);
    const series = m.series?.trim().toLowerCase() || undefined;
    const window = m.window?.trim().toLowerCase() || undefined;
    const noise = m.noise?.trim().toLowerCase() || undefined;
    const bad = metricWindowNoiseError(window, noise);
    if (bad) throw new Error(`${name}: ${bad}`);
    if (!name || !target) throw new Error("A metric is a name and a target");
    if (!key) throw new Error(`A metric name needs a letter or a digit in it: "${name}"`);
    if (metrics.some((x) => x.key === key)) throw new Error(`Two metrics read as the same key: ${key}`);
    if (series && !SERIES_REF.test(series)) throw new Error(`A live series is a metric watch's short id (mw-N), not "${series}"`);
    metrics.push({ key, name, target, ...(series ? { series } : {}), ...(m.guardrail ? { guardrail: true } : {}), ...(window ? { window } : {}), ...(noise ? { noise } : {}) });
  }
  if (metrics.length > INITIATIVE_METRICS_MAX) throw new Error(`A goal or project carries at most ${INITIATIVE_METRICS_MAX} metrics`);
  return metrics;
}

export async function watchIn(ctx: { db: any }, workspace: string, ref: string) {
  const row = await ctx.db.query("metric_watches").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  return row && row.workspace === workspace ? row : null;
}

/** Every series the metrics name is a watch in `workspace`: a goal never reads another workspace's numbers. */
export async function requireSeries(ctx: { db: any }, workspace: string, metrics: readonly InitiativeMetric[]): Promise<void> {
  for (const m of metrics) {
    for (const ref of seriesRefs(m)) if (!(await watchIn(ctx, workspace, ref))) throw new Error(`No metric watch ${ref} in this workspace (cast metrics ls lists them)`);
  }
}

/** The watches a metric reads: its series, and a binomial model's denominator series. */
const seriesRefs = (m: InitiativeMetric): string[] => [m.series, metricDenominatorRef(m)].filter((r): r is string => !!r);

/**
 * The series rows' metrics name, as readings take them; a ref that names
 * nothing in the workspace is absent. A metric read over a window gets the
 * values at its window's slots out of metric_points as `history`, since the
 * row keeps only its newest points; its denominator series gets the same slots.
 */
export async function seriesLookup(ctx: { db: any }, workspace: string, rows: ReadonlyArray<{ metrics?: InitiativeMetric[] }>): Promise<(ref: string) => MetricSeries | undefined> {
  const metrics = rows.flatMap((r) => r.metrics ?? []);
  const refs = new Set(metrics.flatMap(seriesRefs));
  const found = new Map<string, MetricSeries>();
  const rowsByRef = new Map<string, any>();
  for (const ref of refs) {
    const w = await watchIn(ctx, workspace, ref);
    if (!w) continue;
    rowsByRef.set(ref, w);
    found.set(ref, {
      short_id: w.short_id, name: w.name, unit: w.unit ?? null, points: w.points, last_error: w.last_error ?? null,
      ...(w.source_points?.length ? { cohorts: w.source_points } : {}),
      ...(w.version ? { version: w.version } : {}),
    });
  }
  for (const m of metrics) {
    const main = m.series ? found.get(m.series) : undefined;
    const plan = main ? windowPlan(m, main) : null;
    const latest = main?.points[main.points.length - 1]?.at;
    // A reader that dates its own periods is read by them (cohorts); polls only feed its live value.
    if (!plan || !main || latest === undefined || main.cohorts?.length) continue;
    main.history = await slotHistory(ctx, rowsByRef.get(m.series!), main, windowSlotTimes(latest, plan.periodMs, plan.slots), plan.periodMs);
    // A denominator is read where the metric's own values sit, not at the nominal slots: a sparse pair could otherwise miss each other.
    const by = metricDenominatorRef(m);
    const denom = by ? found.get(by) : undefined;
    if (denom) denom.history = await slotHistory(ctx, rowsByRef.get(by!), denom, windowSamples(seriesPool(main), plan.periodMs, plan.slots).map((p) => p.at), plan.periodMs);
  }
  return (ref) => found.get(ref);
}

/**
 * The stored value nearest each time within the slot tolerance (contracts/
 * metricStanding SLOT_TOLERANCE), for times the row's own points do not
 * already answer. Only values of the watch's current definition count; how
 * many older ones sat nearer a slot is kept on the series (`dropped`), so
 * the reading can say they were left out.
 */
async function slotHistory(ctx: { db: any }, watch: any, s: MetricSeries, slots: number[], period: number): Promise<MetricSeries["points"]> {
  const out = new Map<number, { at: number; value: number }>((s.history ?? []).map((p) => [p.at, p]));
  const near = period * SLOT_TOLERANCE;
  const current = ofVersion(definitionOf(watch));
  const dropped = new Set<number>();
  const nearest = async (t: number, side: "before" | "after") => {
    const rows: any[] = await ctx.db.query("metric_points").withIndex("by_watch_at", (q: any) => (side === "before" ? q.eq("watch_id", watch._id).gte("at", t - near).lte("at", t) : q.eq("watch_id", watch._id).gt("at", t).lte("at", t + near))).order(side === "before" ? "desc" : "asc").take(SLOT_SCAN);
    for (const r of rows) if (!current(r)) dropped.add(r.at);
    return rows.find(current);
  };
  for (const t of slots) {
    if (s.points.some((p) => Math.abs(p.at - t) <= near)) continue;
    const hit = [await nearest(t, "before"), await nearest(t, "after")].filter(Boolean).sort((a: any, b: any) => Math.abs(a.at - t) - Math.abs(b.at - t))[0];
    if (hit) out.set(hit.at, { at: hit.at, value: hit.value });
  }
  if (dropped.size) s.dropped = (s.dropped ?? 0) + dropped.size;
  return [...out.values()].sort((a, b) => a.at - b.at);
}
/** Stored values one slot looks through, each side, for one of the current definition. */
const SLOT_SCAN = 50;
