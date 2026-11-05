// Statistics over a metric's values: time-weighted means and quantiles
// (a value weighs as long as it stood), a window's summary, and the
// weekday by hour means the heatmap draws.
import type { Pt } from "./metricModel";

/**
 * How long each value stood, oldest first: the time until the next value,
 * the last one the spacing before it. A weekly value polled every 10 minutes
 * for a day then weighs a week against a day of polls, never 3 against 144,
 * as Grafana and Datadog read a mean over a series with mixed cadence.
 * Evenly spaced values weigh the same, so a regular series reads as its
 * plain mean. `uneven` says the weights differ enough to name it.
 */
export function timeWeights<P extends Pt>(points: readonly P[]): { pts: P[]; w: number[]; uneven: boolean } {
  const pts = [...points].filter((p) => Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  const w = pts.map((p, i) => (i + 1 < pts.length ? pts[i + 1].at - p.at : i ? p.at - pts[i - 1].at : 1));
  if (!w.some((x) => x > 0)) return { pts, w: pts.map(() => 1), uneven: false };
  const pos = w.filter((x) => x > 0);
  return { pts, w, uneven: Math.max(...pos) > 3 * Math.min(...pos) };
}

/** The time-weighted mean (timeWeights); NaN with no values. */
export function weightedMean(points: readonly Pt[]): number {
  const { pts, w } = timeWeights(points);
  const total = w.reduce((s, x) => s + x, 0);
  return pts.reduce((s, p, i) => s + p.value * w[i], 0) / total;
}

/**
 * The `f` quantile of weighted values: each sorted value sits at its share
 * of the weight, ends pinned to 0 and 1, interpolated between neighbours.
 * With equal weights it is quantileSorted's (n-1)·f rule exactly.
 */
export function weightedQuantile(vals: readonly { v: number; w: number }[], f: number): number {
  const n = vals.length;
  if (n === 1) return vals[0].v;
  const total = vals.reduce((s, x) => s + x.w, 0);
  const denom = total - vals[0].w / 2 - vals[n - 1].w / 2;
  if (denom <= 0) return quantileSorted(vals.map((x) => x.v), f);
  let before = 0;
  const pos = vals.map((x) => {
    const at = (before + x.w / 2 - vals[0].w / 2) / denom;
    before += x.w;
    return at;
  });
  for (let i = 0; i + 1 < n; i++) {
    if (f <= pos[i + 1]) {
      const gap = pos[i + 1] - pos[i];
      return gap <= 0 ? vals[i + 1].v : vals[i].v + (vals[i + 1].v - vals[i].v) * ((f - pos[i]) / gap);
    }
  }
  return vals[n - 1].v;
}

/** The `f` quantile of sorted values, interpolated between neighbours. */
function quantileSorted(vals: readonly number[], f: number): number {
  const i = (vals.length - 1) * f;
  const lo = Math.floor(i);
  return lo + 1 < vals.length ? vals[lo] + (vals[lo + 1] - vals[lo]) * (i - lo) : vals[lo];
}

/** Window statistics: min, max, the time-weighted mean (timeWeights) and the last value; `uneven` when the spacing made the weighting matter. */
export function stats(points: Pt[]): { min: number; max: number; avg: number; last: number; uneven: boolean } | null {
  if (!points.length) return null;
  const vals = points.map((p) => p.value);
  const { pts, uneven } = timeWeights(points);
  return { min: Math.min(...vals), max: Math.max(...vals), avg: weightedMean(points), last: pts[pts.length - 1]?.value ?? vals[vals.length - 1], uneven };
}

/** Mean value per weekday and hour, local time. */
export function weekHourCells(points: readonly { at: number; value: number }[]): [number, number, number][] {
  const acc = new Map<number, [number, number]>();
  for (const p of points) {
    const d = new Date(p.at);
    const k = d.getDay() * 24 + d.getHours();
    const a = acc.get(k) ?? [0, 0];
    a[0] += p.value; a[1] += 1;
    acc.set(k, a);
  }
  return [...acc].map(([k, [s, n]]) => [k % 24, Math.floor(k / 24), Math.round((s / n) * 10) / 10]);
}
