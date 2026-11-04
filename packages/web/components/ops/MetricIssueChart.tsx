// A metric issue's own picture (the Datadog pattern: a monitor's event opens
// on its graph): the watch over the issue's life, its line and the stretches
// past it, and the link to the watch's page.
import Link from "next/link";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsGroup, useOpsWatches } from "../../hooks/useSyncOps";
import { useWatchSeries } from "../../hooks/useSyncOpsMetrics";
import { HealthPill, MetricChart } from "./MetricChart";
import { DETAIL_BUCKETS, METRIC_RANGES, chartPoints, durationShort, formatValue, type MetricRange } from "./metricModel";
import { opsHref } from "./opsPaths";
import { OpsEmpty } from "./parts";
import { useIssueEpisodes, useWatchEpisodes } from "./useWatchEpisodes";
import type { OpsGroup, OpsWatch } from "./opsTypes";
import "./metrics.css";

/** "5 episodes · 16d alerting", for a metric issue's header in place of an event count. */
export function EpisodeCount({ group, watch, now }: { group: OpsGroup; watch: OpsWatch | null | undefined; now: number }) {
  const e = useIssueEpisodes(group, watch, now);
  return (
    <span className="ops-num" data-issue-episodes={e.count}>
      <b>{e.count}</b> {e.count === 1 ? "episode" : "episodes"}{e.total > 0 ? ` · ${durationShort(e.total)} alerting` : ""}{e.current !== null ? ` · this one ${durationShort(now - e.current)}` : ""}
    </span>
  );
}

/** The smallest named range that reaches back to `since`, so the issue's chart reads one stable window from the server. */
function rangeCovering(since: number, now: number): MetricRange {
  return METRIC_RANGES.find((r) => r.ms !== null && r.ms >= now - since + 3600_000)?.key ?? "all";
}

/** A metric issue's chart: the watch over the issue's life (its whole history, read from the server), its line and the stretches past it, linking to the watch. */
export function MetricIssueChart({ watchId, since }: { watchId: string; since: number }) {
  const watches = useOpsWatches();
  const now = useCoarseNow(60_000);
  const watch = watches.find((w) => w._id === watchId || w.short_id === watchId);
  const group = useOpsGroup(watch?.group_id ?? null);
  const { episodes, since: alertFrom } = useWatchEpisodes(watch, group);
  const range = rangeCovering(since, now);
  const series = useWatchSeries(watch?._id ?? null, { kind: "range", range }, DETAIL_BUCKETS);
  if (!watch) return <OpsEmpty title="The watch was deleted" />;
  const loading = !series;
  const points = chartPoints(series, watch.points);
  const win = { from: Math.min(since, points[0]?.at ?? since) - 3600_000, to: now };
  // Before the first value held, the alert's announced episodes still draw, on a stretch named as holding no values.
  const held = series?.held_from ?? points[0]?.at ?? null;
  const gap = !loading && (held === null || held - win.from > (win.to - win.from) / 50) ? { from: win.from, to: Math.min(win.to, held ?? win.to) } : null;
  const bands = watch.threshold !== undefined ? episodes.map((e) => ({ from: e.from, to: e.to ?? now })) : undefined;
  return (
    <div className="ops-card" data-metric-issue-chart>
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2"><HealthPill watch={watch} now={now} since={alertFrom} />{formatValue(watch.last_value ?? 0, watch.unit)}{watch.last_at ? <span className="ops-dim font-normal" title={new Date(watch.last_at).toLocaleString()}>read {new Date(watch.last_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span> : null}{watch.threshold !== undefined && <span className="ops-dim font-normal">line {watch.direction === "above" ? ">" : "<"} {formatValue(watch.threshold, watch.unit)}</span>}</span>
        <Link href={opsHref.metric(watch.short_id)} className="ops-mono hover:underline font-normal">{watch.short_id}</Link>
      </div>
      <div className="px-3 pt-2 pb-1.5">
        <MetricChart points={points} win={win} loading={loading} interval_ms={Math.max(watch.interval_ms, series?.step_ms ?? 0)} threshold={watch.threshold} warn={watch.warn} direction={watch.direction} unit={watch.unit} height={150} full paused={watch.status === "paused"} gap={gap} episodes={bands} />
      </div>
    </div>
  );
}
