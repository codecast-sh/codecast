
// The Metrics views' arithmetic: time windows, gaps, alert bands, crossings,
// period comparison, a watch's health, and the overview's order. Pure: no
// React, no store. The alert rule is the server's (lib/ingestGroups
// metricCrosses): above alerts when the value is over the line, below when
// it is under it.
import { formatSeriesValue } from "@codecast/shared/contracts/initiative";
import type { WindowDelta } from "./metricSeries";
import type { OpsSource, OpsWatch } from "./opsTypes";

export type Pt = { at: number; value: number };
export type Direction = "above" | "below";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ── Time windows ──

export const METRIC_RANGES = [
  { key: "1h", label: "1h", ms: HOUR },
  { key: "24h", label: "24h", ms: DAY },
  { key: "7d", label: "7d", ms: 7 * DAY },
  { key: "30d", label: "30d", ms: 30 * DAY },
  { key: "all", label: "All", ms: null },
] as const;
export type MetricRange = (typeof METRIC_RANGES)[number]["key"];

export function isMetricRange(v: unknown): v is MetricRange {
  return METRIC_RANGES.some((r) => r.key === v);
}

export type Win = { from: number; to: number };

/** The window a range names, ending now. "All" spans every point held (a day when there are none). */
export function rangeWindow(range: MetricRange, points: Pt[], now: number): Win {
  const r = METRIC_RANGES.find((x) => x.key === range)!;
  if (r.ms !== null) return { from: now - r.ms, to: now };
  const first = points.length ? Math.min(...points.map((p) => p.at)) : now - DAY;
  return { from: Math.min(first, now - HOUR), to: now };
}

/** The window that spans every listed watch's points: the overview's "All". */
export function spanOf(watches: Pick<OpsWatch, "points">[], now: number): Win {
  let from = now;
  for (const w of watches) for (const p of w.points) if (p.at < from) from = p.at;
  return { from: Math.min(from, now - HOUR), to: now };
}

/** The points inside a window, with the nearest one either side so a line runs to the edges. */
export function inWindow<P extends Pt>(points: P[], win: Win): P[] {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  let lo = sorted.findIndex((p) => p.at >= win.from);
  if (lo === -1) return sorted.length ? sorted.slice(-1).filter((p) => p.at >= win.from) : [];
  let hi = sorted.length - 1;
  while (hi >= 0 && sorted[hi].at > win.to) hi--;
  if (lo > 0) lo--;
  if (hi < sorted.length - 1) hi++;
  return sorted.slice(lo, hi + 1);
}

/**
 * One joined run cut at the window's edges, as Grafana draws a panel's
 * edge: the values inside it, and where a neighbour outside joins one of
 * them, the line's value at the edge itself (interpolated, carrying no
 * min or max). A run whose values all lie outside, with none straddling
 * the window, draws nothing.
 */
export function clipRunToWindow<P extends Pt>(pts: readonly P[], win: Win): Pt[] {
  const at = (a: Pt, b: Pt, t: number): Pt => ({ at: t, value: a.value + ((b.value - a.value) * (t - a.at)) / (b.at - a.at || 1) });
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    if (p.at >= win.from && p.at <= win.to) {
      if (prev && prev.at < win.from) out.push(at(prev, p, win.from));
      out.push(p);
      continue;
    }
    // Two neighbours straddling an edge with nothing between them inside: the segment across the window.
    if (prev && prev.at < win.from && p.at > win.from) out.push(at(prev, p, win.from));
    if (prev && prev.at <= win.to && p.at > win.to) out.push(at(prev, p, win.to));
  }
  return out;
}

/** The usual gap between consecutive points (the median); 0 with fewer than two. */
export function cadenceOf(points: readonly Pt[]): number {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i].at - pts[i - 1].at);
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** A run of points the chart joins with one line, and the spacing it was read at. `sparse` is a value standing alone (nothing within reach either side), drawn as a short tick. */
export type LineRun<P extends Pt = Pt> = { points: P[]; sparse: boolean; step: number };

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The points as runs a line may join, judged against the series' own
 * cadence the way PostHog trends and Grafana's "connect null values" at the
 * step do. Each gap is weighed against the spacing of the values around it
 * (the median of up to three gaps either side, the closer-spaced side when
 * they differ, never under `step_ms`, the poll or the server's bucket): a
 * gap within about twice that spacing joins, a longer one breaks unless a
 * wider gap sits beside it (the break goes to the widest). So a
 * weekly series is one line through its weeks, a missed stretch of hourly
 * polls is a hole, and a daily backfill running into hourly polls breaks
 * where the cadence changes rather than ramping through a day never read.
 * A run of one value is `sparse`. `join` is how many times the spacing
 * around a gap it may run and still be joined (a card passes a wider one).
 */
export function lineRuns<P extends Pt>(points: readonly P[], step_ms: number, join = 2.2): LineRun<P>[] {
  const pts = [...points].sort((a, b) => a.at - b.at);
  if (!pts.length) return [];
  const step = Math.max(1, step_ms);
  const gaps = pts.slice(1).map((p, i) => p.at - pts[i].at);
  // gaps[i] runs from pts[i] to pts[i + 1].
  const joins = gaps.map((g, i) => {
    const before = median(gaps.slice(Math.max(0, i - 3), i));
    const after = median(gaps.slice(i + 1, i + 4));
    const local = before && after ? Math.min(before, after) : before || after;
    // Two values alone: nothing to judge them by but the step, and a pair is a line.
    if (!local) return gaps.length === 1 ? true : g <= join * step;
    if (g <= join * Math.max(step, local)) return true;
    // A gap matching one beside it (within 5%) is a cadence the series keeps, a daily backfill's day: joined, as dataHoles calls it no hole,
    // unless the cadence changes on its other side (the last day before hourly polls, which stays a break).
    const twin = (n: number | undefined) => n !== undefined && Math.abs(n - g) <= 0.05 * Math.max(n, g);
    const steadyFrom = (n: number | undefined) => n === undefined || n * join >= g;
    if ((twin(gaps[i - 1]) && steadyFrom(gaps[i + 1])) || (twin(gaps[i + 1]) && steadyFrom(gaps[i - 1]))) return true;
    // Where the cadence changes, only the widest gap there breaks: the last daily value still joins the daily run.
    return g < (gaps[i - 1] ?? 0) || g < (gaps[i + 1] ?? 0);
  });
  const out: { points: P[] }[] = [{ points: [pts[0]] }];
  for (let i = 1; i < pts.length; i++) {
    if (joins[i - 1]) out[out.length - 1].points.push(pts[i]);
    else out.push({ points: [pts[i]] });
  }
  return out.map((r) => ({ points: r.points, sparse: r.points.length === 1, step: Math.max(step, cadenceOf(r.points)) }));
}

/** The spacing from which a run reads as values far apart: its points get markers, and the tooltip names the spacing. */
export const COARSE_STEP = 12 * HOUR;

/** One sparse value as the chart draws it: a dot with a short level either side, never a line to its neighbours. */
export type Tick<P extends Pt = Pt> = { pt: P; from: number; to: number };

/**
 * Sparse values as ticks: each value's level drawn a little either side of
 * it (three tenths of the gap to its nearest neighbour, at least `minHalf`),
 * so a run of daily values reads as daily levels and no slope is drawn
 * through hours that were never read.
 */
export function ticksOf<P extends Pt>(points: readonly P[], minHalf: number, among: readonly Pt[] = points): Tick<P>[] {
  const pts = [...points].sort((a, b) => a.at - b.at);
  // Neighbours are every value drawn, so a tick never reaches over a joined run beside it.
  const all = [...among].map((p) => p.at).sort((a, b) => a - b);
  return pts.map((pt) => {
    let near = Infinity;
    for (const at of all) if (at !== pt.at) near = Math.min(near, Math.abs(at - pt.at));
    const half = Number.isFinite(near) ? Math.max(minHalf, near * 0.3) : minHalf;
    return { pt, from: pt.at - half, to: pt.at + half };
  });
}

/** A stretch the source sent nothing for, as the chart marks it: its edges, and how many polls it missed. */
export type DataHole = Win & { missed: number };

/** How many times its own spacing a gap must run before the chart marks it as missing data (Grafana's "no data" strip). */
export const HOLE_FACTOR = 4;

/**
 * The stretches with no values: each gap between neighbouring values at
 * least HOLE_FACTOR times the spacing the series keeps beside it. That
 * spacing is the gap just beside it on either side when that gap is regular, the coarser,
 * and never under `step_ms` (the poll, or the server's bucket): a gap is
 * regular when it is short (under HOLE_FACTOR steps) or matches a gap next to
 * it (within 5%, three values evenly spaced: a daily backfill). So daily
 * values running into hourly polls are no hole, a steady daily stretch is no
 * hole however few of its values a window holds, and an outage after a lone
 * value is judged by the polls around that value, never by the daily
 * cadence further back. Judged on the points alone, so a window, a zoom or a
 * narrower chart of the same values marks the same stretches. `poll_ms`
 * counts the polls it missed.
 */
export function dataHoles(points: readonly Pt[], step_ms: number, poll_ms: number = step_ms): DataHole[] {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const base = Math.max(1, step_ms);
  const gaps = pts.slice(1).map((p, i) => p.at - pts[i].at);
  const twin = (i: number, j: number) => gaps[j] !== undefined && Math.abs(gaps[i] - gaps[j]) <= 0.05 * Math.max(gaps[i], gaps[j]);
  const regular = gaps.map((g, i) => g < HOLE_FACTOR * base || twin(i, i - 1) || twin(i, i + 1));
  const overall = cadenceOf(pts);
  const out: DataHole[] = [];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    if (regular[i]) continue;
    // Only the gap just beside counts: past a lone value the cadence further back says nothing about the polls around it.
    const left = i > 0 && regular[i - 1] ? gaps[i - 1] : 0;
    const right = i + 1 < gaps.length && regular[i + 1] ? gaps[i + 1] : 0;
    const spacing = Math.max(base, left, right, !left && !right ? overall : 0);
    if (g < HOLE_FACTOR * spacing) continue;
    out.push({ from: pts[i].at, to: pts[i + 1].at, missed: Math.max(0, Math.round(g / Math.max(1, poll_ms)) - 1) });
  }
  return out;
}

/** A run's points split where a hole runs between two of them, so a line never crosses a stretch with no values. */
export function splitAtHoles<P extends Pt>(points: readonly P[], holes: readonly Win[]): P[][] {
  if (!holes.length) return [points.slice()];
  const out: P[][] = [[]];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && holes.some((h) => h.from === points[i - 1].at && h.to === points[i].at)) out.push([]);
    out[out.length - 1].push(points[i]);
  }
  return out;
}

/** Windows with the holes cut out of them: an alert band never runs through a stretch with no values. */
export function cutHoles<T extends Win>(wins: readonly T[], holes: readonly Win[]): Win[] {
  let out: Win[] = wins.map((w) => ({ from: w.from, to: w.to }));
  for (const h of holes) {
    out = out.flatMap((w) => {
      if (h.to <= w.from || h.from >= w.to) return [w];
      const parts: Win[] = [];
      if (h.from > w.from) parts.push({ from: w.from, to: h.from });
      if (h.to < w.to) parts.push({ from: h.to, to: w.to });
      return parts;
    });
  }
  return out;
}

/** The runs' points alone: the shape a comparison line takes. */
export function segments(points: Pt[], step_ms: number): Pt[][] {
  return lineRuns(points, step_ms).map((r) => r.points);
}

/**
 * Where the line truly stops: a gap far longer than both the expected step
 * (10x) and the spacing of the values around it (3x), as a lone value
 * weeks before polling began. Returns the indexes (into the sorted points)
 * each break starts at.
 */
export function breaksIn(points: readonly Pt[], step_ms: number): number[] {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].at - pts[i - 1].at;
    if (g <= 10 * Math.max(1, step_ms)) continue;
    // The spacing of the values before the gap, or after it for the first one.
    const local = cadenceOf(pts.slice(Math.max(0, i - 6), i)) || cadenceOf(pts.slice(i, i + 6));
    if (local === 0 || g > 3 * local) out.push(i);
  }
  return out;
}

/** The points after the last real break: the stretch a change can honestly be measured across. */
export function continuousTail<P extends Pt>(points: readonly P[], step_ms: number): P[] {
  const pts = [...points].sort((a, b) => a.at - b.at);
  const b = breaksIn(pts, step_ms);
  return b.length ? pts.slice(b[b.length - 1]) : pts;
}

/** Where a watch's chart should start: its first value, skipping leading stray stretches of under three values cut off by a break. Null with none. */
export function fitStart(points: readonly Pt[], step_ms: number): number | null {
  const pts = [...points].sort((a, b) => a.at - b.at);
  if (!pts.length) return null;
  const cuts = [0, ...breaksIn(pts, step_ms), pts.length];
  for (let k = 0; k < cuts.length - 1; k++) {
    if (cuts[k + 1] - cuts[k] >= 3 || k === cuts.length - 2) return pts[cuts[k]].at;
  }
  return pts[0].at;
}

// ── The alert line ──

export function crosses(value: number, threshold: number, direction: Direction): boolean {
  return direction === "above" ? value > threshold : value < threshold;
}

export type Crossing = { at: number; value: number; kind: "crossed" | "recovered" };

/**
 * Where the points cross today's line and come back, oldest first. `seeded`
 * takes the first value as the state the series was already in, so a window
 * that opens past the line (mid-alert) reports no crossing at its edge: with
 * nothing before it, the first value shows a state, never a transition.
 */
export function crossings(points: Pt[], threshold: number | undefined, direction: Direction, seeded = false): Crossing[] {
  if (threshold === undefined) return [];
  const pts = [...points].sort((a, b) => a.at - b.at);
  const out: Crossing[] = [];
  let alerting = seeded && pts.length > 0 && crosses(pts[0].value, threshold, direction);
  for (const p of pts) {
    const now = crosses(p.value, threshold, direction);
    if (now !== alerting) out.push({ at: p.at, value: p.value, kind: now ? "crossed" : "recovered" });
    alerting = now;
  }
  return out;
}

/** The stretches the points sit on the alerting side; a stretch still open runs to `until`. */
export function alertBands(points: Pt[], threshold: number | undefined, direction: Direction, until: number): Win[] {
  const bands: Win[] = [];
  let open: number | null = null;
  for (const c of crossings(points, threshold, direction)) {
    if (c.kind === "crossed") open = c.at;
    else if (open !== null) {
      bands.push({ from: open, to: c.at });
      open = null;
    }
  }
  if (open !== null) bands.push({ from: open, to: Math.max(until, open) });
  return bands;
}

/** When the current alert began, from the points: the start of the trailing alerting run. Null when not alerting. */
export function alertSince(w: Pick<OpsWatch, "points" | "threshold" | "direction">): number | null {
  if (w.threshold === undefined) return null;
  const pts = [...w.points].sort((a, b) => a.at - b.at);
  let since: number | null = null;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (!crosses(pts[i].value, w.threshold, w.direction)) break;
    since = pts[i].at;
  }
  return since;
}

/**
 * How far the latest value sits from alerting, as a share of the line:
 * positive is room left, negative is how far past it. Null with no line or no value.
 */
export function margin(w: Pick<OpsWatch, "last_value" | "threshold" | "direction">): number | null {
  if (w.threshold === undefined || w.last_value === null) return null;
  const room = w.direction === "above" ? w.threshold - w.last_value : w.last_value - w.threshold;
  return room / (Math.abs(w.threshold) || 1);
}

// ── Comparison ──

/** The points a span earlier, moved forward onto this window: "the same time last period". */
export function previousPeriod(points: Pt[], win: Win): Pt[] {
  const span = win.to - win.from;
  return points.filter((p) => p.at >= win.from - span && p.at <= win.to - span).sort((a, b) => a.at - b.at).map((p) => ({ at: p.at + span, value: p.value }));
}

/** The value nearest `at`, within `tolerance`. */
export function valueNear(points: Pt[], at: number, tolerance: number): Pt | null {
  let best: Pt | null = null;
  for (const p of points) if (Math.abs(p.at - at) <= tolerance && (!best || Math.abs(p.at - at) < Math.abs(best.at - at))) best = p;
  return best;
}

/** The latest value against the one a span before it: the change and its share. Null when nothing that old is held. */
export function priorDelta(points: Pt[], span: number): { prior: number; change: number; pct: number | null } | null {
  if (points.length < 2) return null;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const last = sorted[sorted.length - 1];
  const prior = valueNear(sorted.slice(0, -1), last.at - span, span / 4);
  if (!prior) return null;
  const change = last.value - prior.value;
  return { prior: prior.value, change, pct: prior.value === 0 ? null : change / Math.abs(prior.value) };
}

/** The span a card compares against: a day when the points reach that far, else an hour. */
export function compareSpan(points: Pt[]): number {
  if (points.length < 2) return DAY;
  const first = Math.min(...points.map((p) => p.at));
  const last = Math.max(...points.map((p) => p.at));
  return last - first >= DAY ? DAY : HOUR;
}

export function spanLabel(ms: number): string {
  if (ms >= DAY) return `${Math.round(ms / DAY)}d`;
  if (ms >= HOUR) return `${Math.round(ms / HOUR)}h`;
  return `${Math.max(1, Math.round(ms / MIN))}m`;
}

/**
 * How the page names the window its numbers cover, so every label under one
 * range control says the same thing: a range or a zoom by its length ("30d",
 * "in 30d"), All by where it starts ("since Oct 5"), since All is as long as
 * the watch's own history.
 */
export function windowName(win: Win, all: boolean): { short: string; within: string } {
  if (!all) {
    const s = spanLabel(win.to - win.from);
    return { short: s, within: `in ${s}` };
  }
  const since = `since ${new Date(win.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  return { short: since, within: since };
}

/**
 * An elapsed duration, never rounded up: whole units floored, and two units
 * from an hour on (45m, 6h 20m, 2d 12h), as PagerDuty and Datadog name how
 * long an alert has run. 2.5 days stays "2d 12h" instead of flipping to 3d.
 */
export function durationShort(ms: number): string {
  const t = Math.max(0, ms);
  const two = (big: number, bigU: string, small: number, smallU: string) => {
    const a = Math.floor(t / big);
    const b = Math.floor((t - a * big) / small);
    return b ? `${a}${bigU} ${b}${smallU}` : `${a}${bigU}`;
  };
  if (t >= DAY) return two(DAY, "d", HOUR, "h");
  if (t >= HOUR) return two(HOUR, "h", MIN, "m");
  if (t >= MIN) return `${Math.floor(t / MIN)}m`;
  return `${Math.max(1, Math.floor(t / 1000))}s`;
}

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

// ── A watch's health ──

/**
 * One word for where a watch stands, in the order the overview sorts by:
 * alerting, failing to read, a read that just failed with an older value
 * still standing, never read, ok against its line, a plain series with no
 * line (it claims no health), paused.
 */
export const HEALTH = ["alert", "error", "retrying", "warn", "nodata", "ok", "series", "paused"] as const;
export type Health = (typeof HEALTH)[number];

export const HEALTH_LOOK: Record<Health, { label: string; ink: string }> = {
  alert: { label: "Alert", ink: "var(--sol-red)" },
  error: { label: "Erroring", ink: "var(--sol-orange)" },
  retrying: { label: "Retrying", ink: "var(--sol-yellow)" },
  warn: { label: "Warn", ink: "var(--sol-yellow)" },
  nodata: { label: "No data", ink: "var(--sol-text-dim)" },
  ok: { label: "OK", ink: "var(--sol-green)" },
  series: { label: "No line", ink: "var(--sol-blue)" },
  paused: { label: "Paused", ink: "var(--sol-text-dim)" },
};

type HealthFields = Pick<OpsWatch, "status" | "last_error" | "last_value" | "threshold" | "state"> & Partial<Pick<OpsWatch, "warn" | "direction" | "missed">>;

/**
 * Alert is the server's state (it may need several reads in a row); warn is
 * the latest value past the warning level while not alerting. Erroring
 * takes two failed reads in a row (or no value ever), so one slow answer
 * does not flip a watch back and forth; a single miss with an older value
 * standing is Retrying, the word the home band and the Apps board use, so
 * the chips, the table, the cards and the watch page name it alike.
 */
export function watchHealth(w: HealthFields): Health {
  if (w.status === "paused") return "paused";
  if (w.state === "alert" && w.threshold !== undefined) return "alert";
  if (w.last_error && ((w.missed ?? 2) >= 2 || w.last_value === null)) return "error";
  if (w.last_error) return "retrying";
  if (w.last_value === null) return "nodata";
  if (w.threshold === undefined) return "series";
  if (w.warn !== undefined && crosses(w.last_value, w.warn, w.direction ?? "above")) return "warn";
  return "ok";
}

/** Whether alerts are held back right now. */
export function isMutedAt(w: Pick<OpsWatch, "muted_until">, now: number): boolean {
  return w.muted_until !== undefined && w.muted_until > now;
}

export function healthCounts(ws: HealthFields[]): Record<Health, number> {
  const out = Object.fromEntries(HEALTH.map((h) => [h, 0])) as Record<Health, number>;
  for (const w of ws) out[watchHealth(w)]++;
  return out;
}

// ── A watch's state, as every surface counts it ──

/**
 * The one set of states every Ops surface names and counts a watch under (the
 * Metrics chips and filter, the Metrics tab's count, the home's watch band):
 * its health, with Blind split out of Erroring. Blind is an erroring watch
 * whose source's failing reader is why (the reader's row on the home is its
 * fix, once for every watch it starves).
 */
export const WATCH_STATES = ["alert", "blind", "error", "retrying", "warn", "nodata", "ok", "series", "paused"] as const;
export type WatchState = (typeof WATCH_STATES)[number];

export const WATCH_STATE_LOOK: Record<WatchState, { label: string; ink: string }> = { ...HEALTH_LOOK, blind: { label: "Blind", ink: "var(--sol-orange)" } };

/** A watch whose last read failed while an older value still stands: not erroring yet (watchHealth needs two failed reads in a row), not fine either. */
export function watchRetrying(w: HealthFields): boolean {
  return watchHealth(w) === "retrying";
}

/** The watches blind behind their source's failing reader: erroring, and named in that reader's starves (sourceHealth). */
export function blindWatchIds(ws: readonly OpsWatch[], healthOf: (sourceId: string) => { starves?: { watchIds: readonly string[] } } | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of ws) if (watchHealth(w) === "error" && healthOf(w.source_id)?.starves?.watchIds.includes(w._id)) out.add(w._id);
  return out;
}

export function watchState(w: HealthFields & Pick<OpsWatch, "_id">, blind?: ReadonlySet<string>): WatchState {
  const h = watchHealth(w);
  return h === "error" && blind?.has(w._id) ? "blind" : h;
}

export function watchStateCounts(ws: readonly (HealthFields & Pick<OpsWatch, "_id">)[], blind?: ReadonlySet<string>): Record<WatchState, number> {
  const out = Object.fromEntries(WATCH_STATES.map((h) => [h, 0])) as Record<WatchState, number>;
  for (const w of ws) out[watchState(w, blind)]++;
  return out;
}

// ── The overview's order ──

export const WATCH_SORTS = [
  { key: "state", label: "State" },
  { key: "name", label: "Name" },
  { key: "change", label: "Change" },
  { key: "alerting", label: "Alerting for" },
  { key: "source", label: "Source" },
  { key: "interval", label: "Cadence" },
  { key: "updated", label: "Last read" },
] as const;
export type WatchSort = (typeof WATCH_SORTS)[number]["key"];

export const WATCH_GROUPS = [
  { key: "none", label: "No grouping" },
  { key: "source", label: "Source" },
  { key: "kind", label: "Kind" },
] as const;
export type WatchGrouping = (typeof WATCH_GROUPS)[number]["key"];

/**
 * State first (HEALTH order). Within alert, the longest alerting first;
 * within ok, the closest to its line first; then by name.
 */
export function sortWatches<W extends OpsWatch>(ws: W[], sort: WatchSort, changeOf?: (w: W) => WindowDelta | null): W[] {
  const rank = (w: W) => HEALTH.indexOf(watchHealth(w));
  const byName = (a: W, b: W) => a.name.localeCompare(b.name);
  // The change the cards show (periodChange) when the caller has it; a watch with no change sorts last.
  const change = (w: W) => {
    if (!changeOf) return Math.abs(priorDelta(w.points, compareSpan(w.points))?.pct ?? 0);
    const d = changeOf(w);
    return d ? Math.abs(d.pct ?? (d.base === 0 ? (d.change ? 10 : 0) : d.change / Math.abs(d.base))) : -1;
  };
  const cmp: Record<WatchSort, (a: W, b: W) => number> = {
    state: (a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      const h = watchHealth(a);
      if (h === "alert") return (alertSince(a) ?? Infinity) - (alertSince(b) ?? Infinity) || byName(a, b);
      if (h === "ok") return (margin(a) ?? Infinity) - (margin(b) ?? Infinity) || byName(a, b);
      return byName(a, b);
    },
    name: byName,
    change: (a, b) => change(b) - change(a) || byName(a, b),
    // Longest alerting first; the rest in state order.
    alerting: (a, b) => (watchHealth(a) === "alert" ? alertSince(a) ?? Infinity : Infinity) - (watchHealth(b) === "alert" ? alertSince(b) ?? Infinity : Infinity) || rank(a) - rank(b) || byName(a, b),
    source: (a, b) => (a.source_name ?? "~").localeCompare(b.source_name ?? "~") || rank(a) - rank(b) || byName(a, b),
    interval: (a, b) => a.interval_ms - b.interval_ms || byName(a, b),
    updated: (a, b) => (b.last_at ?? 0) - (a.last_at ?? 0) || byName(a, b),
  };
  return [...ws].sort(cmp[sort]);
}

export type WatchFilter = { health: WatchState | null; search: string; /** Watches blind behind a failing reader (blindWatchIds), so the Blind filter and chip agree. */ blind?: ReadonlySet<string> };

export function filterWatches<W extends OpsWatch>(ws: W[], f: WatchFilter): W[] {
  const q = f.search.trim().toLowerCase();
  return ws.filter((w) => (!f.health || watchState(w, f.blind) === f.health) && (!q || w.name.toLowerCase().includes(q) || w.short_id.toLowerCase().includes(q) || (w.source_name ?? "").toLowerCase().includes(q)));
}

export const KIND_LABEL: Record<string, string> = { hogql: "HogQL", insight: "Insight", reader: "Reader", volume: "Volume" };

/** The watches in labelled groups, each group in the order given; one unlabelled group when not grouping. */
export function groupWatches<W extends OpsWatch>(ws: W[], by: WatchGrouping): { key: string; label: string; rows: W[] }[] {
  if (by === "none") return [{ key: "all", label: "", rows: ws }];
  const keyOf = (w: W) => (by === "source" ? w.source_name ?? "removed source" : w.threshold === undefined ? "No line" : "Alerting on a line");
  const groups = new Map<string, W[]>();
  for (const w of ws) groups.set(keyOf(w), [...(groups.get(keyOf(w)) ?? []), w]);
  return [...groups.entries()].map(([key, rows]) => ({ key, label: key, rows })).sort((a, b) => a.label.localeCompare(b.label));
}

// ── Axes and numbers ──

export function formatValue(v: number, unit?: string | null): string {
  if (unit) return formatSeriesValue(v, unit);
  return Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Whether every value is a whole number: a count, whose mean reads to one decimal at most. */
export function isIntegral(points: readonly Pt[]): boolean {
  return points.length > 0 && points.every((p) => Number.isInteger(p.value));
}

/**
 * Whether a watch measures a count, judged on the values it read (the row's
 * own polls) rather than what a range draws: a folded bucket's mean of a
 * count is fractional, and judging by it changed a count's precision with
 * the range. The drawn values decide only when the row holds none.
 */
export function measuresCount(read: readonly Pt[], shown: readonly Pt[]): boolean {
  return read.length ? isIntegral(read) : isIntegral(shown);
}

/** A derived value (a mean, a percentile, a change) at the precision its series has: a count's mean to one decimal, none from 100 up. */
export function formatMeasure(v: number, unit: string | null | undefined, integral: boolean): string {
  if (!integral || !Number.isFinite(v)) return formatValue(v, unit);
  return formatValue(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10, unit);
}

export function formatPct(pct: number): string {
  const p = Math.abs(pct * 100);
  return `${pct >= 0 ? "+" : "-"}${p >= 100 ? Math.round(p).toLocaleString("en-US") : p.toFixed(p >= 10 ? 0 : 1)}%`;
}

/** Up to `n` round ticks across [lo, hi]. */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (hi === lo) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}

/** The least span, in points, a percent's y axis covers (yDomain). */
export const PCT_MIN_SPAN = 1;

/** The y extent for points, a line and a comparison, padded so nothing sits on the frame. */
export function yDomain(series: Pt[][], threshold?: number, unit?: string | null): [number, number] {
  const vals = series.flat().map((p) => p.value);
  if (threshold !== undefined) vals.push(threshold);
  if (!vals.length) return [0, 1];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    const d = Math.abs(lo) * 0.1 || 1;
    lo -= d;
    hi += d;
  }
  // Grafana's soft min and max: the axis spans at least a tenth of the value's
  // size, so a 12.9 to 13.0 wobble is a ripple, never a cliff. A percent is
  // read on its own 0 to 100 scale: the axis spans at least one point, so a
  // success rate moving from 94.7% to 96.1% fills the plot rather than a
  // stripe along its top.
  const minSpan = unit === "%" ? PCT_MIN_SPAN : Math.max(Math.abs(lo), Math.abs(hi)) * 0.1;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const pad = (hi - lo) * 0.08;
  // A non-negative series keeps its floor at zero rather than padding under it.
  return [lo >= 0 && lo - pad < 0 ? 0 : lo - pad, hi + pad];
}

const TICK_STEPS = [MIN, MIN * 5, MIN * 15, MIN * 30, HOUR, HOUR * 3, HOUR * 6, HOUR * 12, DAY, DAY * 2, DAY * 7, DAY * 14, DAY * 30, DAY * 90];

/** The tick step for a window: the smallest round step that gives at most `n` ticks. */
export function tickStep(win: Win, n = 5): number {
  const span = win.to - win.from;
  return TICK_STEPS.find((s) => span / s <= n) ?? DAY * 180;
}

/**
 * Time ticks for a window, about `n` of them, at round local times: whole
 * minutes or hours under a day, local midnights from a day up (stepped by
 * calendar day, so a clock change never shifts them off midnight).
 */
export function timeTicks(win: Win, n = 5): number[] {
  const step = tickStep(win, n);
  const out: number[] = [];
  if (step < DAY) {
    const tz = new Date(win.from).getTimezoneOffset() * MIN;
    for (let t = Math.ceil((win.from - tz) / step) * step + tz; t <= win.to; t += step) out.push(t);
    return out;
  }
  const days = Math.round(step / DAY);
  const d = new Date(win.from);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < win.from) d.setDate(d.getDate() + 1);
  // Steps of several days land on the same days whatever the window's start.
  while (Math.round((d.getTime() - d.getTimezoneOffset() * MIN) / DAY) % days !== 0) d.setDate(d.getDate() + 1);
  for (; d.getTime() <= win.to; d.setDate(d.getDate() + days)) out.push(d.getTime());
  return out;
}

/**
 * Labels for ticks: a midnight is its date, any other tick its time, so a
 * multi-day window reads "Nov 2, 12 PM, Nov 3" and never repeats a date. A
 * window that crosses a new year names the year on the first tick of each.
 */
export function tickLabels(ticks: readonly number[], win: Win): string[] {
  const crossesYear = new Date(win.from).getFullYear() !== new Date(win.to).getFullYear();
  const wholeHours = ticks.every((t) => new Date(t).getMinutes() === 0);
  return ticks.map((t, i) => {
    const d = new Date(t);
    const prevYear = i ? new Date(ticks[i - 1]).getFullYear() : null;
    if (d.getHours() === 0 && d.getMinutes() === 0) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(crossesYear && prevYear !== d.getFullYear() ? { year: "numeric" } : {}) });
    }
    return d.toLocaleTimeString(undefined, wholeHours ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" });
  });
}

export function stampLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── The overview's address ──

export type Layout = "cards" | "table";
export type MetricsQuery = { health: WatchState | null; q: string; sort: WatchSort; group: WatchGrouping; range: MetricRange; layout: Layout };

export const METRICS_QUERY_DEFAULT: MetricsQuery = { health: null, q: "", sort: "state", group: "none", range: "7d", layout: "cards" };

/** The overview's filters from its address; anything unknown falls back to the default. */
export function parseMetricsQuery(get: (k: string) => string | null): MetricsQuery {
  const d = METRICS_QUERY_DEFAULT;
  const pick = <T extends string>(v: string | null, ok: readonly T[], dflt: T): T => (v && (ok as readonly string[]).includes(v) ? (v as T) : dflt);
  const h = get("state");
  return {
    health: h && (WATCH_STATES as readonly string[]).includes(h) ? (h as WatchState) : null,
    q: get("q") ?? "",
    sort: pick(get("sort"), WATCH_SORTS.map((s) => s.key), d.sort),
    group: pick(get("group"), WATCH_GROUPS.map((g) => g.key), d.group),
    range: pick(get("range"), METRIC_RANGES.map((r) => r.key), d.range),
    layout: pick(get("view"), ["cards", "table"] as const, d.layout),
  };
}

/** The address params for a query: only what differs from the default, so a plain view keeps a plain address. */
export function metricsQueryParams(q: MetricsQuery): Record<string, string | null> {
  const d = METRICS_QUERY_DEFAULT;
  return {
    state: q.health,
    q: q.q.trim() || null,
    sort: q.sort === d.sort ? null : q.sort,
    group: q.group === d.group ? null : q.group,
    range: q.range === d.range ? null : q.range,
    view: q.layout === d.layout ? null : q.layout,
  };
}
