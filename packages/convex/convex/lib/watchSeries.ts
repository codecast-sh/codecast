// A watched metric's stored series (X7): the points a watch keeps, the
// source's own history merged under them, and the instants a backfill reads.
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";

/** The watch's points with one more, oldest first, cut to the newest GROUP_RULES.metric_points. */
export function appendMetricPoint(points: { at: number; value: number }[], point: { at: number; value: number }): { at: number; value: number }[] {
  return [...points, point].slice(-GROUP_RULES.metric_points);
}

/**
 * The source's own past values under the watch's points: those older than
 * the first polled point (a poll's reading wins over the series at its time),
 * oldest first, cut to the newest GROUP_RULES.metric_points.
 */
export function mergeMetricHistory(points: { at: number; value: number }[], history: { at: number; value: number }[]): { points: { at: number; value: number }[]; added: number } {
  const firstPolled = points.length ? points[0].at : Infinity;
  const older = history.filter((p) => p.at < firstPolled && Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  const merged = [...older, ...points].slice(-GROUP_RULES.metric_points);
  return { points: merged, added: Math.max(0, merged.length - Math.min(points.length, GROUP_RULES.metric_points)) };
}

/**
 * A metric reader's own dated series over the watch's points: the reader's
 * value wins at a time both hold, and the newest GROUP_RULES.metric_points
 * stay. A reader that answers its history on every read keeps the series it
 * answers, rather than one point a poll (a daily number polled hourly would
 * otherwise fill the row with repeats of one day).
 */
export function mergeReaderSeries(points: { at: number; value: number }[], series: { at: number; value: number }[]): { at: number; value: number }[] {
  const byAt = new Map(points.map((p) => [p.at, p]));
  for (const p of series) if (Number.isFinite(p.value)) byAt.set(p.at, p);
  return [...byAt.values()].sort((a, b) => a.at - b.at).slice(-GROUP_RULES.metric_points);
}

const DAY_MS = 24 * 3600_000;

/** What a backfill asks for: back from the oldest point the watch holds (or now), within `days`. */
export type HistorySpan = { now: number; oldest: number | null; interval_ms: number; days: number };

/**
 * The past instants a backfill reads a watch at, oldest first: a day apart
 * when the query's window is a day or more (a daily count read hourly would
 * repeat itself 24 times), else one poll interval apart. They run back from
 * the oldest point the watch already holds and stay within `days`. One read
 * per instant, so there are at most METRIC_HISTORY_READS of them: when the
 * span holds more, the step widens to a whole multiple of the base one that
 * covers it, and the history is coarser rather than shorter.
 */
export const METRIC_HISTORY_READS = 100;

export function historyInstants(span: HistorySpan, window_ms: number | null): number[] {
  const base = window_ms !== null && window_ms >= DAY_MS ? DAY_MS : span.interval_ms;
  const from = Math.min(span.oldest ?? span.now, span.now);
  const floor = span.now - span.days * DAY_MS;
  const step = base * Math.max(1, Math.ceil((from - floor) / base / METRIC_HISTORY_READS));
  const out: number[] = [];
  for (let at = from - step; at > floor && out.length < METRIC_HISTORY_READS; at -= step) out.push(at);
  return out.reverse();
}
