// Metrics series as the server answers them (metrics.series, metricsSeriesMany),
// and the period change every Metrics surface shows. Pure: no React, no store.
import { continuousTail, DAY, formatValue, METRIC_RANGES, MIN, weightedMean, type MetricRange, type Pt, type Win } from "./metricModel";
import type { OpsWatch } from "./opsTypes";

// ── Series from the server (metrics.series, metrics.seriesMany) ──

/** One drawn point; a folded bucket (or an hour's rollup) carries its extremes and `n`, the values it holds. */
export type SeriesPt = Pt & { min?: number; max?: number; n?: number };

/** How many values the watch read across some drawn points: each folded point counts the reads inside it. */
export function readCount(points: readonly Pt[]): number {
  return points.reduce((s, p) => s + Math.max(1, (p as SeriesPt).n ?? 1), 0);
}

/** A watch's values over one window as the store holds them (opsWatchSeries), keyed by seriesKey. */
export type OpsWatchSeries = {
  _id: string;
  watch_id: string;
  from: number;
  to: number;
  /** The oldest value the watch holds at all. */
  held_from: number | null;
  /** The bucket width the server folded to; 0 when these are the values as read. */
  step_ms: number;
  resolution: "raw" | "hour";
  points: SeriesPt[];
};

/** Which window a chart asks for: a named range ending now, the period before it, or an exact zoom. */
export type SeriesSpec = { kind: "range"; range: MetricRange } | { kind: "prev"; range: MetricRange } | { kind: "zoom"; win: Win };

export const DETAIL_BUCKETS = 300;
export const CARD_BUCKETS = 80;

export function seriesKey(watchId: string, spec: SeriesSpec, buckets: number): string {
  const w = spec.kind === "zoom" ? `z${Math.round(spec.win.from)}-${Math.round(spec.win.to)}` : `${spec.kind === "prev" ? "p" : ""}${spec.range}`;
  return `${watchId}|${w}|${buckets}`;
}

export function rangeMs(range: MetricRange): number | null {
  return METRIC_RANGES.find((r) => r.key === range)!.ms;
}

/** The span the change compares across: the range itself, or the last 7 days for All, which has no period before it. */
export const CHANGE_SPAN_ALL = 7 * DAY;
export function changeSpan(range: MetricRange): number {
  return rangeMs(range) ?? CHANGE_SPAN_ALL;
}

/**
 * The range whose series the change reads: the range itself, and for All the
 * 7d range, so "Last 7d vs prior 7d" is read off the same values at All, at
 * 7d and on the overview's card, never off All's coarse buckets.
 */
export function changeRange(range: MetricRange): MetricRange {
  return range === "all" ? "7d" : range;
}

/**
 * The one change every Metrics surface shows: the mean of the newest
 * `span` before `end` against the mean of the period of the same length
 * before it (Datadog's change widget, the same comparison as the chart's
 * "vs previous" overlay). Null without values on both sides, never a
 * different comparison in its place. The percent is dropped for a tiny
 * baseline and the change reads as an amount.
 */
export function periodChange(points: readonly Pt[], prev: readonly Pt[] | null | undefined, span: number, end: number): WindowDelta | null {
  const cur = points.filter((p) => p.at > end - span && p.at <= end);
  const before = (prev ?? []).filter((p) => p.at > end - 2 * span && p.at <= end - span);
  if (!cur.length || !before.length) return null;
  return windowDelta(cur, span, before);
}

/**
 * The change a range shows on every Metrics surface, from one input: the
 * card-size series of changeRange(range) and the period before it (the
 * overview's reads, which the watch page subscribes to as well), with the
 * row's newer values appended. A finer series of the same window folds its
 * buckets differently and moves the prior mean by a few tenths, so it never
 * feeds this number.
 */
export function rangeChange(cur: Pick<OpsWatchSeries, "points"> | undefined, prev: Pick<OpsWatchSeries, "points"> | undefined, tail: readonly Pt[], range: MetricRange, now: number): WindowDelta | null {
  if (!cur) return null;
  const pts = chartPoints(cur, tail);
  // The window ends at the newest value held, never at a surface's own clock: the card ticks a coarse minute and the page half a minute, and an end set by either moves the mean by a few tenths between them.
  const end = pts.reduce((m, p) => Math.max(m, p.at), -Infinity);
  return periodChange(pts, prev?.points ?? null, changeSpan(range), Number.isFinite(end) ? end : now);
}

/**
 * The Mean cell of a watch page's strip. When the change compares the page's
 * own window (a named range other than All, not zoomed), the cell is that
 * change's current mean, so the strip never names two means for one window
 * (the detail series folds its buckets apart from the card-size one the
 * change and the overview read). Otherwise, the mean of what the chart draws.
 */
export function stripMean(drawnMean: number | null, change: WindowDelta | null, range: MetricRange, zoomed: boolean): number | null {
  if (!zoomed && range !== "all" && change && change.vs === "prior") return change.now;
  return drawnMean;
}

/**
 * The change stat's state: a number, a read still on its way (never told as
 * absence), or a read that came back with nothing in one of the two periods.
 */
export function changeState(change: WindowDelta | null, answered: boolean): "value" | "reading" | "none" {
  return change ? "value" : answered ? "none" : "reading";
}

/**
 * Of the answers a store already holds for one window (a cached detail
 * read, the overview's card-size one), the one to paint while the live
 * answer is on its way: the one reaching furthest back, so the page never
 * shows less history than the card it was opened from; ties go to the newer.
 */
export function fullestHeld<S extends Pick<OpsWatchSeries, "points" | "to" | "held_from">>(...held: (S | undefined)[]): S | undefined {
  let best: S | undefined;
  const first = (s: S) => (s.points.length ? s.points[0].at : Infinity);
  for (const s of held) {
    if (!s) continue;
    if (!best || first(s) < first(best) || (first(s) === first(best) && s.to > best.to)) best = s;
  }
  return best;
}

/** The query args a spec names (watch ref and scope added by the caller); null when there is nothing to ask. */
export function seriesArgs(spec: SeriesSpec, buckets: number): Record<string, number> | null {
  if (spec.kind === "zoom") return { from: Math.round(spec.win.from), to: Math.round(spec.win.to), buckets };
  const ms = rangeMs(spec.range);
  if (spec.kind === "prev") {
    const span = changeSpan(spec.range);
    return { span_ms: span, offset_ms: span, buckets };
  }
  return ms === null ? { buckets } : { span_ms: ms, buckets };
}

/**
 * What a chart draws: the server's answer, with any newer values the watch
 * row already holds appended (the row moves with each poll, the answer a beat
 * later), else the row's own values when no answer has come.
 */
export function chartPoints(series: Pick<OpsWatchSeries, "points"> | undefined, tail: readonly Pt[]): SeriesPt[] {
  if (!series) return [...tail].sort((a, b) => a.at - b.at);
  const last = series.points.length ? series.points[series.points.length - 1].at : -Infinity;
  return [...series.points, ...tail.filter((p) => p.at > last).sort((a, b) => a.at - b.at)];
}

/**
 * The drawn points with the read behind each announced transition put in
 * where the series holds no value within `step_ms` of it (a stretch of daily
 * backfill before hourly polls, where the alert was read but no day's value
 * stands). The recovery the list names then sits on the line, and the empty
 * stretch after it is judged against those polls, so it reads as missing
 * data (dataHoles) rather than as one more day of the daily cadence.
 */
export function withAnnouncedReads(points: readonly SeriesPt[], announced: readonly { at: number; value: number | null; inferred?: boolean }[], step_ms: number): SeriesPt[] {
  if (!points.length) return points.slice();
  const first = points[0].at;
  const last = points[points.length - 1].at;
  const near = Math.max(1, step_ms);
  const add = announced.filter((t) => !t.inferred && t.value !== null && t.at > first && t.at < last && !points.some((p) => Math.abs(p.at - t.at) <= near));
  if (!add.length) return points.slice();
  return [...points, ...add.map((t) => ({ at: t.at, value: t.value as number }))].sort((a, b) => a.at - b.at);
}

/** Points moved forward by `ms`: the period before, laid over this one. */
export function shiftPoints(points: readonly Pt[], ms: number): Pt[] {
  return points.map((p) => ({ at: p.at + ms, value: p.value }));
}

/**
 * A card's window: the shared one, or, when the watch holds less than it,
 * just the stretch it holds (as PostHog tiles and Grafana's "relative to
 * data" do), so a 12h watch is not a sliver at the edge of a 7d frame.
 * `fitted` is the span shown when it was cut.
 */
export function cardWindow(win: Win, heldFrom: number | null): { win: Win; fitted: number | null } {
  const span = win.to - win.from;
  if (heldFrom === null || heldFrom <= win.from + span * 0.1) return { win, fitted: null };
  const from = Math.max(win.from, heldFrom - Math.max(MIN, (win.to - heldFrom) * 0.03));
  return { win: { from, to: win.to }, fitted: win.to - heldFrom };
}

/**
 * The change from the first value to the last across what a window shows;
 * null with fewer than two values. Given the expected step, it is measured
 * only across the stretch after the last real break (breaksIn), never from
 * a lone value weeks before the rest. `since` is where it was measured from.
 */
export function windowChange(points: readonly Pt[], step_ms?: number): { first: number; last: number; change: number; pct: number | null; since: number } | null {
  const sorted = step_ms === undefined ? [...points].sort((a, b) => a.at - b.at) : continuousTail(points, step_ms);
  if (sorted.length < 2) return null;
  const first = sorted[0].value;
  const last = sorted[sorted.length - 1].value;
  const change = last - first;
  return { first, last, change, pct: first === 0 ? null : change / Math.abs(first), since: sorted[0].at };
}

/** How small a baseline is, against the values' own spread, before a change reads as an amount instead of a percent. */
export const TINY_BASELINE = 0.02;

/**
 * Whether a baseline is about zero: zero, or under TINY_BASELINE of the
 * values' own spread. Only then does a change read as an amount; any other
 * baseline gives a percent, on the page, the card and the table sort alike,
 * so one watch never switches units with the range.
 */
export function tinyBaseline(base: number, values: readonly number[]): boolean {
  if (base === 0) return true;
  if (!values.length) return false;
  const spread = Math.max(...values) - Math.min(...values);
  return spread > 0 && Math.abs(base) < spread * TINY_BASELINE;
}

/** A window's change as the stat and the overview show it. `vs` names the baseline: the previous period's mean, or the window's first value. `pct` is null when the baseline is too small to divide by. */
export type WindowDelta = { change: number; pct: number | null; base: number; now: number; vs: "prior" | "first"; since: number };

const mean = (pts: readonly Pt[]) => weightedMean(pts);

/**
 * The change a window shows: with the previous period's values, the
 * window's mean against that period's mean (Datadog's change widget);
 * without them, the last value against the first across the unbroken
 * stretch (windowChange). Either way the percent is dropped for a tiny
 * baseline and the change reads as an amount.
 */
export function windowDelta(points: readonly Pt[], step_ms: number, prev?: readonly Pt[] | null): WindowDelta | null {
  if (prev && prev.length && points.length) {
    const now = mean(points);
    const base = mean(prev);
    const change = now - base;
    const all = [...points, ...prev].map((p) => p.value);
    return { change, pct: tinyBaseline(base, all) ? null : change / Math.abs(base), base, now, vs: "prior", since: Math.min(...points.map((p) => p.at)) };
  }
  const w = windowChange(points, step_ms);
  if (!w) return null;
  const tail = continuousTail(points, step_ms).map((p) => p.value);
  return { change: w.change, pct: tinyBaseline(w.first, tail) ? null : w.pct, base: w.first, now: w.last, vs: "first", since: w.since };
}

/** A change read as an amount from its baseline: "+126 from 9". */
export function changeAmount(change: number, base: number, unit?: string | null): string {
  return `${change >= 0 ? "+" : "-"}${formatValue(Math.abs(change), unit)} from ${formatValue(base, unit)}`;
}

/** Whether a change moved toward the alerting side: bad, good, or flat when there is no line or no move. */
export function changeTone(w: Pick<OpsWatch, "threshold" | "direction">, change: number): "bad" | "good" | "flat" {
  if (w.threshold === undefined || change === 0) return "flat";
  return (w.direction === "above") === change > 0 ? "bad" : "good";
}
