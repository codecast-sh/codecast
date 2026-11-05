// A watched metric over time. The chart itself is MetricPlot (chart/), drawn
// with ECharts on the app's theme; this module names its props and holds the
// watch's state pill that sits beside it.
import type { ReactNode } from "react";
import { AlertTriangle, BellOff } from "lucide-react";
import type { OpsWatch } from "./opsTypes";
import { HEALTH_LOOK, alertSince, durationShort, isMutedAt, stampLabel, watchHealth, type Direction, type Pt, type Win } from "./metricModel";
import type { SeriesPt } from "./metricSeries";
import type { ChartMark } from "./metricEvents";

export { MetricPlot as MetricChart } from "./chart/MetricPlot";

export type MetricChartProps = {
  points: SeriesPt[];
  win: Win;
  interval_ms: number;
  threshold?: number;
  /** A warning level short of the line, drawn as its own dashed line. */
  warn?: number;
  direction: Direction;
  unit?: string;
  /** Moments drawn as vertical markers (full charts only). */
  marks?: ChartMark[];
  /** Ships in the window, drawn as ticks on the time axis and clustered where close (full charts only). */
  ships?: ChartMark[];
  /** The previous period, already moved onto this window. */
  compare?: Pt[];
  height?: number;
  /** Axes, zoom and the draggable line. */
  full?: boolean;
  paused?: boolean;
  /** Ink of the line; the alert red stays the alert's. */
  ink?: string;
  onZoom?: (win: Win) => void;
  onResetZoom?: () => void;
  /** A dragged line, on release. */
  onThreshold?: (value: number) => void;
  label?: string;
  /** The window's values are still on their way: a loading bar, and nothing drawn that could be read as the answer. */
  loading?: boolean;
  /** Values for the window are drawn but a finer answer is on its way: the loading bar over the drawing. */
  stale?: boolean;
  /** Values a query being edited answers, drawn over the chart before it is saved. */
  preview?: Pt[];
  /** A line being typed, drawn where it would sit before it is saved. */
  ghostLine?: number;
  /** A card's chart names the moment it starts at, bottom left. */
  axisStart?: boolean;
  /** The stretch with no values held (the watch page's All reaching back to its first alert), drawn hatched with `gapAction` on it. */
  gap?: Win | null;
  gapAction?: ReactNode;
  /** The alert's announced episodes: the strip under the plot, and the bands where no values are held. */
  episodes?: Win[];
  /** The transitions the page lists, each drawn at the value that caused it (full charts only): filled when announced, hollow when read off the values. */
  transitions?: readonly { at: number; kind: "crossed" | "recovered"; value: number | null; inferred?: boolean }[];
  /** The watch's poll, to count the polls a stretch with no values missed (full charts); the drawing's step when absent. */
  poll_ms?: number;
  /** A value read just now, past the series' newest point: the newest dot, joined to the series by a dashed segment. */
  live?: Pt | null;
};

/** A watch's state as a pill: how long an alert has run, a read error's glyph, nothing for a plain series that is reading. */
export function HealthPill({ watch, now, since: episodeSince }: { watch: OpsWatch; now: number; /** When the running alert began (metricModel currentEpisodeSince); the values' own run when absent. */ since?: number | null }) {
  const h = watchHealth(watch);
  const muted = isMutedAt(watch, now);
  if (h === "series" && !muted) return null;
  const look = HEALTH_LOOK[h];
  const since = h === "alert" ? (episodeSince ?? alertSince(watch)) : null;
  return (
    <span className="mx-health" style={{ ["--ink" as string]: look.ink }} title={h === "error" || h === "retrying" ? watch.last_error : muted ? `Muted until ${stampLabel(watch.muted_until!)}` : undefined} data-health={h} data-muted={muted ? "" : undefined}>
      {h === "error" && <AlertTriangle aria-hidden />}
      {muted && <BellOff aria-label="muted" />}
      {h === "series" ? "Muted" : look.label}{since ? ` ${durationShort(now - since)}` : ""}
    </span>
  );
}
