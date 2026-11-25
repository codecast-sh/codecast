// One metric watch as a card: its name and health, the newest value with its
// change against the period before, the line it alerts on, and its chart. The
// Metrics overview's grid draws these, and so does an `mw-N` reference alone on
// its line in a message or doc (MetricRefCard), so a watch looks the same
// wherever it is shown.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { relTimeShort } from "../../lib/utils";
import { HealthPill, MetricChart } from "./MetricChart";
import { cardWindow, changeAmount, changeTone, chartPoints, changeSpan, type WindowDelta, type OpsWatchSeries, type SeriesPt } from "./metricSeries";
import { watchErrorText } from "./metricEvents";
import { fitStart, formatPct, formatValue, inWindow, spanLabel, watchHealth, type MetricRange, type Win } from "./metricModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import { useReadNow } from "./useReadNow";
import type { OpsSource, OpsWatch } from "./opsTypes";
import "./ops.css";
import "./metrics.css";

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

/** The newest span's mean against the period before it (periodChange), inked by whether it moved toward the line; nothing without values on both sides. */
export function Delta({ watch, d, span, blank }: { watch: OpsWatch; d: WindowDelta | null; span: number; blank?: boolean }) {
  if (!d) return blank ? <span className="mx-delta" data-tone="flat" title={`no values in the ${spanLabel(span)} before`}>–</span> : null;
  const formula = `mean ${formatValue(Math.round(d.now * 100) / 100, watch.unit)} over the last ${spanLabel(span)} vs ${formatValue(Math.round(d.base * 100) / 100, watch.unit)} the ${spanLabel(span)} before`;
  if (d.change === 0) return <span className="mx-delta" data-tone="flat" title={formula}>0%</span>;
  return (
    <span className="mx-delta" data-tone={changeTone(watch, d.change)} title={formula} data-change-pct={d.pct === null ? undefined : Math.round(d.pct * 100)}>
      {d.pct === null ? changeAmount(d.change, d.base, watch.unit) : <>{d.change > 0 ? "▲" : "▼"} {formatPct(d.pct)}</>}
    </span>
  );
}

export function lineTag(w: OpsWatch): string | null {
  return w.threshold === undefined ? null : `${w.direction === "above" ? ">" : "<"} ${formatValue(w.threshold, w.unit)}`;
}

export function WatchCard({ watch: w, range, drawn, change, now, since, issue, provider, cursor }: { watch: OpsWatch; range: MetricRange; drawn: Drawn; change: WindowDelta | null; now: number; since: number | null; issue?: string; provider?: OpsSource["provider"]; cursor: boolean }) {
  const router = useRouter();
  const h = watchHealth(w);
  const href = watchHref(w.short_id, range);
  const open = () => router.push(href);
  return (
    <div
      className="mx-card"
      data-health={h}
      data-cursor={cursor ? "" : undefined}
      data-watch={w.short_id}
      // The whole card takes a click; its name is the one link a keyboard or a screen reader stops on (the card holds links and buttons).
      onClick={(e) => { if (!(e.target as Element).closest("a, button")) open(); }}
    >
      <div className="mx-card-top">
        <Link href={href} className="mx-name" title={w.name}>{w.name}</Link>
        <HealthPill watch={w} now={now} since={since} />
      </div>
      <div className="mx-value-row">
        <span className="mx-value">{w.last_value === null ? "–" : formatValue(w.last_value, w.unit)}</span>
        <Delta watch={w} d={change} span={changeSpan(range)} />
        {h === "error" && w.last_at && <span className="mx-value-age" data-value-age>last {relTimeShort(w.last_at, now)} ago</span>}
        <span className="flex-1" />
        {lineTag(w) && <span className="mx-line-tag">line {lineTag(w)}</span>}
      </div>
      <MetricChart
        points={drawn.points}
        win={drawn.win}
        interval_ms={drawn.step}
        axisStart={drawn.fitted !== null}
        threshold={w.threshold}
        warn={w.warn}
        direction={w.direction}
        unit={w.unit}
        height={h === "alert" ? 72 : 64}
        paused={h === "paused"}
        label={`${w.name} over ${spanLabel(drawn.win.to - drawn.win.from)}`}
      />
      {w.last_error && w.status !== "paused" && <CardError watch={w} />}
      <div className="mx-foot">
        <span className="mx-src"><ProviderIcon provider={provider ?? "posthog"} /><span className="truncate min-w-0">{w.source_name ?? "removed source"}</span></span>
        <span className="ops-mono">{w.short_id}</span>
        {issue && <Link href={opsHref.issue(issue)} className="ops-mono hover:underline" onClick={(e) => e.stopPropagation()}>{issue}</Link>}
        <span className="flex-1" />
        {!(h === "error" && w.last_at) && <span className="ops-num" title={w.last_at ? new Date(w.last_at).toLocaleString() : undefined}>{w.last_at ? relTimeShort(w.last_at, now) : "never read"}</span>}
      </div>
    </div>
  );
}

/** A failing read on a card: the reader and its error, and Read now. */
export function CardError({ watch }: { watch: OpsWatch }) {
  const { asking, readNow } = useReadNow([watch]);
  const h = watchHealth(watch);
  return (
    <div className="mx-card-error" data-health={h} data-watch-error-inline onClick={(e) => e.stopPropagation()}>
      <AlertTriangle aria-hidden />
      <span className="mx-card-error-text" title={watchErrorText(watch) ?? undefined}>{watchErrorText(watch)}</span>
      <button type="button" className="mx-icon-btn" disabled={asking} onClick={readNow} aria-label="Read now" title="Read now" data-watch-read-now>
        {asking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </button>
    </div>
  );
}
