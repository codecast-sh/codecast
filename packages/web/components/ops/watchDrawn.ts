// What a metric watch card draws, apart from the card: its page link, its
// points in a window and the line it alerts on. The Metrics grid and an
// `mw-N` reference card both compute these before drawing a WatchCard.
import { cardWindow, chartPoints, type OpsWatchSeries, type SeriesPt } from "./metricSeries";
import { fitStart, formatValue, inWindow, type MetricRange, type Win } from "./metricModel";
import { opsHref } from "./opsPaths";
import type { OpsWatch } from "./opsTypes";

/** A watch's page opened on the overview's range, so the change it reads is the one the card showed. */
export function watchHref(shortId: string, range: MetricRange): string {
  return range === "all" ? opsHref.metric(shortId) : `${opsHref.metric(shortId)}?range=${range}`;
}

/** What one watch draws in a window: the server's history for it, else the row's own newest values. `step` is the spacing its line expects. */
export type Drawn = { win: Win; fitted: number | null; points: SeriesPt[]; visible: SeriesPt[]; step: number };

export function drawnFor(w: OpsWatch, series: OpsWatchSeries | undefined, win: Win): Drawn {
  const points = chartPoints(series, w.points);
  const step = Math.max(w.interval_ms, series?.step_ms ?? 0);
  // The card fits the stretch the watch really holds: a lone value weeks before the rest does not widen it.
  const fit = cardWindow(win, fitStart(points.filter((p) => p.at >= win.from), step));
  return { ...fit, points, step, visible: inWindow(points, fit.win).filter((p) => p.at >= fit.win.from && p.at <= fit.win.to) };
}

export function lineTag(w: OpsWatch): string | null {
  return w.threshold === undefined ? null : `${w.direction === "above" ? ">" : "<"} ${formatValue(w.threshold, w.unit)}`;
}
