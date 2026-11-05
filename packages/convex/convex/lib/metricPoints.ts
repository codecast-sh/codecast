// A watch's full history (X7): every value it ever read, one metric_points
// row each, and an hourly rollup per watch (metric_rollups: count, sum, min,
// max) kept in step with them. The watch row keeps only its newest
// GROUP_RULES.metric_points values for cards and the alert rule; a chart over
// a window reads here. A window up to METRIC_SERIES.raw_span_ms reads the raw
// values, a wider one the hourly rollups, and either is cut to about the
// buckets asked for (average, min and max per bucket), the way a Grafana
// panel's max data points or a Datadog rollup bound what one chart draws.
import type { Doc, Id } from "../_generated/dataModel";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export const METRIC_SERIES = {
  /** Windows up to this span read raw values; wider ones read hourly rollups. */
  raw_span_ms: 3 * DAY,
  raw_read_max: 6000,
  rollup_read_max: 9000,
  /** Hours one watch reads in an overview read, which reads many watches at once: about two months. */
  many_rollup_max: 1500,
  buckets_default: 300,
  buckets_max: 600,
  /** How many watches one overview read takes. */
  many_max: 30,
  /** Rows one purge pass deletes. */
  purge_batch: 400,
} as const;

export type MetricPt = { at: number; value: number };
/** One drawn point: the bucket's average at its mean time, with the bucket's extremes and how many values it holds. */
export type SeriesPoint = { at: number; value: number; min: number; max: number; n: number };
type Entry = { at: number; n: number; sum: number; min: number; max: number };

export const hourOf = (at: number) => Math.floor(at / HOUR) * HOUR;

/** Count, sum, min and max of some values. */
export function rollupOf(points: readonly MetricPt[]): { n: number; sum: number; min: number; max: number } {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    sum += p.value;
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
  }
  return { n: points.length, sum, min, max };
}

/**
 * Entries inside [from, to] as at most `buckets` drawn points. Fewer entries
 * than buckets come back one each; more are folded into equal time buckets,
 * each the count-weighted average with its min and max. The buckets sit on
 * a grid fixed to the epoch (multiples of the width), never to the window's
 * start, so two reads of the same range a minute apart, or the overview's and
 * the watch page's, fold the same values together and say the same means.
 * Each point carries `n`, the values it holds. `step_ms` is the bucket
 * width, 0 when nothing was folded.
 */
export function bucketize(entries: readonly Entry[], from: number, to: number, buckets: number): { points: SeriesPoint[]; step_ms: number } {
  const inside = entries.filter((e) => e.at >= from && e.at <= to && e.n > 0).sort((a, b) => a.at - b.at);
  const n = Math.max(1, Math.floor(buckets));
  if (inside.length <= n) return { points: inside.map((e) => ({ at: e.at, value: e.sum / e.n, min: e.min, max: e.max, n: e.n })), step_ms: 0 };
  const step = Math.ceil((to - from) / n) || 1;
  const out: SeriesPoint[] = [];
  let key = -1;
  let acc = { atSum: 0, k: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
  const flush = () => {
    if (acc.n) out.push({ at: Math.round(acc.atSum / acc.k), value: acc.sum / acc.n, min: acc.min, max: acc.max, n: acc.n });
  };
  for (const e of inside) {
    const b = Math.floor(e.at / step);
    if (b !== key) {
      flush();
      key = b;
      acc = { atSum: 0, k: 0, n: 0, sum: 0, min: Infinity, max: -Infinity };
    }
    acc.atSum += e.at;
    acc.k++;
    acc.n += e.n;
    acc.sum += e.sum;
    if (e.min < acc.min) acc.min = e.min;
    if (e.max > acc.max) acc.max = e.max;
  }
  flush();
  return { points: out, step_ms: step };
}

/** Finite values, one per time (the last given wins), oldest first. */
function cleanPoints(points: readonly MetricPt[]): MetricPt[] {
  const byAt = new Map<number, MetricPt>();
  for (const p of points) if (Number.isFinite(p.at) && Number.isFinite(p.value)) byAt.set(p.at, { at: p.at, value: p.value });
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

/** The raw values in [from, to]; over `max` of them, the newest `max`. */
async function rawBetween(ctx: { db: any }, watchId: Id<"metric_watches">, from: number, to: number, max: number): Promise<Doc<"metric_points">[]> {
  const rows: Doc<"metric_points">[] = await ctx.db
    .query("metric_points")
    .withIndex("by_watch_at", (q: any) => q.eq("watch_id", watchId).gte("at", from).lte("at", to))
    .order("desc")
    .take(max);
  return rows.filter((r) => r.at >= from && r.at <= to);
}

/** Whether the watch's history has moved into metric_points yet (a watch made before the table holds its values only on its row). */
export async function holdsPoints(ctx: { db: any }, watchId: Id<"metric_watches">): Promise<boolean> {
  return !!(await ctx.db.query("metric_points").withIndex("by_watch_at", (q: any) => q.eq("watch_id", watchId)).first());
}

/**
 * Values into the watch's history: a time it does not hold is added, a time
 * it holds with another value takes the new one, and every hour touched has
 * its rollup recounted from the raw values. Returns how many were added.
 */
export async function writePoints(ctx: { db: any }, watchId: Id<"metric_watches">, points: readonly MetricPt[]): Promise<number> {
  const pts = cleanPoints(points);
  if (!pts.length) return 0;
  const held = await rawBetween(ctx, watchId, pts[0].at, pts[pts.length - 1].at, METRIC_SERIES.raw_read_max);
  const byAt = new Map(held.map((r) => [r.at, r]));
  const touched = new Set<number>();
  let added = 0;
  for (const p of pts) {
    const row = byAt.get(p.at);
    if (!row) {
      await ctx.db.insert("metric_points", { watch_id: watchId, at: p.at, value: p.value });
      added++;
      touched.add(hourOf(p.at));
    } else if (row.value !== p.value) {
      await ctx.db.patch(row._id, { value: p.value });
      touched.add(hourOf(p.at));
    }
  }
  for (const hour of touched) {
    const inHour = await rawBetween(ctx, watchId, hour, hour + HOUR - 1, METRIC_SERIES.raw_read_max);
    const r = rollupOf(inHour);
    const row = await ctx.db.query("metric_rollups").withIndex("by_watch_hour", (q: any) => q.eq("watch_id", watchId).eq("hour", hour)).first();
    if (row) await ctx.db.patch(row._id, r);
    else if (r.n) await ctx.db.insert("metric_rollups", { watch_id: watchId, hour, ...r });
  }
  return added;
}

/** The oldest time the watch holds a value for, in the table or on its row; null when it holds none. */
export async function oldestHeld(ctx: { db: any }, watch: Pick<Doc<"metric_watches">, "_id" | "points">): Promise<number | null> {
  const first = await ctx.db.query("metric_points").withIndex("by_watch_at", (q: any) => q.eq("watch_id", watch._id)).first();
  const row = watch.points.length ? Math.min(...watch.points.map((p) => p.at)) : null;
  if (!first) return row;
  return row === null ? first.at : Math.min(first.at, row);
}

export type SeriesAnswer = {
  from: number;
  to: number;
  /** The oldest value the watch holds at all, so a chart can say how far back it reaches. */
  held_from: number | null;
  /** The bucket width the points were folded to; 0 when they are the values as read. */
  step_ms: number;
  resolution: "raw" | "hour";
  points: SeriesPoint[];
};

/**
 * The watch's values over [from, to] as at most `buckets` points. `from`
 * null reads everything it holds. The row's own newest values join the
 * table's, so a watch whose history predates metric_points still draws.
 */
export async function readSeries(
  ctx: { db: any },
  watch: Pick<Doc<"metric_watches">, "_id" | "points">,
  from: number | null,
  to: number,
  buckets: number,
  rollupMax: number = METRIC_SERIES.rollup_read_max,
): Promise<SeriesAnswer> {
  const held_from = await oldestHeld(ctx, watch);
  const f = from ?? held_from ?? to - DAY;
  const n = Math.min(Math.max(1, Math.round(buckets)), METRIC_SERIES.buckets_max);
  const rowPts = watch.points.filter((p) => p.at >= f && p.at <= to);
  if (to - f <= METRIC_SERIES.raw_span_ms) {
    const raw = await rawBetween(ctx, watch._id, f, to, METRIC_SERIES.raw_read_max);
    const byAt = new Map<number, MetricPt>(raw.map((r) => [r.at, { at: r.at, value: r.value }]));
    for (const p of rowPts) if (!byAt.has(p.at)) byAt.set(p.at, p);
    const entries = [...byAt.values()].map((p) => ({ at: p.at, n: 1, sum: p.value, min: p.value, max: p.value }));
    return { from: f, to, held_from, resolution: "raw", ...bucketize(entries, f, to, n) };
  }
  const rollups: Doc<"metric_rollups">[] = (await ctx.db
    .query("metric_rollups")
    .withIndex("by_watch_hour", (q: any) => q.eq("watch_id", watch._id).gte("hour", hourOf(f)).lte("hour", to))
    .order("desc")
    .take(rollupMax)).filter((r: Doc<"metric_rollups">) => r.hour >= hourOf(f) && r.hour <= to);
  const hours = new Set(rollups.map((r) => r.hour));
  // An hourly rollup sits at the middle of its hour, inside the window.
  const entries: Entry[] = rollups.map((r) => ({ at: Math.min(Math.max(r.hour + HOUR / 2, f), to), n: r.n, sum: r.sum, min: r.min, max: r.max }));
  for (const p of rowPts) if (!hours.has(hourOf(p.at))) entries.push({ at: p.at, n: 1, sum: p.value, min: p.value, max: p.value });
  return { from: f, to, held_from, resolution: "hour", ...bucketize(entries, f, to, n) };
}

/** Deletes up to one batch of a removed watch's history; true when more is left. */
export async function purgePoints(ctx: { db: any }, watchId: Id<"metric_watches">): Promise<boolean> {
  const raw = await ctx.db.query("metric_points").withIndex("by_watch_at", (q: any) => q.eq("watch_id", watchId)).take(METRIC_SERIES.purge_batch);
  for (const r of raw) await ctx.db.delete(r._id);
  const roll = await ctx.db.query("metric_rollups").withIndex("by_watch_hour", (q: any) => q.eq("watch_id", watchId)).take(METRIC_SERIES.purge_batch);
  for (const r of roll) await ctx.db.delete(r._id);
  return raw.length === METRIC_SERIES.purge_batch || roll.length === METRIC_SERIES.purge_batch;
}
