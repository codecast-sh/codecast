// The live series a goal's or a project's numbers read (contracts/initiative
// InitiativeMetric.series): metric watches named by short id, held to the
// row's own workspace. One validator for the stored metric shape (initiatives
// and projects share it), one check a write passes, and one lookup every
// reader (the role card, `cast brief`, the org scope view) builds its
// readings from, so a role and the page read the same value.
import { v } from "convex/values";
import { INITIATIVE_METRICS_MAX, metricKeyOf, type InitiativeMetric, type MetricSeries } from "@codecast/shared/contracts/initiative";

export const metricValidator = v.object({ key: v.string(), name: v.string(), target: v.string(), series: v.optional(v.string()), guardrail: v.optional(v.boolean()) });
export const metricArgValidator = v.object({ key: v.optional(v.string()), name: v.string(), target: v.string(), series: v.optional(v.union(v.string(), v.null())), guardrail: v.optional(v.boolean()) });
export type MetricArg = { key?: string; name: string; target: string; series?: string | null; guardrail?: boolean };

const clean = (text: string, max: number) => text.trim().slice(0, max);
const SERIES_REF = /^mw-\d+$/;

/** A list of metrics as a write gives it, checked and keyed: a name and a target each, a series named by its short id, at most INITIATIVE_METRICS_MAX. */
export function cleanMetrics(raw: MetricArg[]): InitiativeMetric[] {
  const metrics: InitiativeMetric[] = [];
  for (const m of raw) {
    const name = clean(String(m.name ?? ""), 80);
    const target = clean(String(m.target ?? ""), 40);
    const key = metricKeyOf(m.key?.trim() || name);
    const series = m.series?.trim().toLowerCase() || undefined;
    if (!name || !target) throw new Error("A metric is a name and a target");
    if (!key) throw new Error(`A metric name needs a letter or a digit in it: "${name}"`);
    if (metrics.some((x) => x.key === key)) throw new Error(`Two metrics read as the same key: ${key}`);
    if (series && !SERIES_REF.test(series)) throw new Error(`A live series is a metric watch's short id (mw-N), not "${series}"`);
    metrics.push({ key, name, target, ...(series ? { series } : {}), ...(m.guardrail ? { guardrail: true } : {}) });
  }
  if (metrics.length > INITIATIVE_METRICS_MAX) throw new Error(`A goal or project carries at most ${INITIATIVE_METRICS_MAX} metrics`);
  return metrics;
}

async function watchIn(ctx: { db: any }, workspace: string, ref: string) {
  const row = await ctx.db.query("metric_watches").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
  return row && row.workspace === workspace ? row : null;
}

/** Every series the metrics name is a watch in `workspace`: a goal never reads another workspace's numbers. */
export async function requireSeries(ctx: { db: any }, workspace: string, metrics: readonly InitiativeMetric[]): Promise<void> {
  for (const m of metrics) {
    if (m.series && !(await watchIn(ctx, workspace, m.series))) throw new Error(`No metric watch ${m.series} in this workspace (cast metrics ls lists them)`);
  }
}

/** The series rows' metrics name, as readings take them; a ref that names nothing in the workspace is absent. */
export async function seriesLookup(ctx: { db: any }, workspace: string, rows: ReadonlyArray<{ metrics?: InitiativeMetric[] }>): Promise<(ref: string) => MetricSeries | undefined> {
  const refs = new Set(rows.flatMap((r) => (r.metrics ?? []).flatMap((m) => (m.series ? [m.series] : []))));
  const found = new Map<string, MetricSeries>();
  for (const ref of refs) {
    const w = await watchIn(ctx, workspace, ref);
    if (w) found.set(ref, { short_id: w.short_id, name: w.name, unit: w.unit ?? null, points: w.points, last_error: w.last_error ?? null });
  }
  return (ref) => found.get(ref);
}
