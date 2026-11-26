// A metric watch named alone on its line (`mw-12`) in a message, a doc or a
// chat line: the same card the Metrics overview draws, live. The watch row
// comes from the reference's resolution (metrics.webGetWatch), its values for
// the window from metrics.series through the store, so the chart moves as the
// watch reads and several references in a row read as a dashboard.
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchSeries } from "../../hooks/useSyncOpsMetrics";
import { currentEpisodeSince } from "./metricEvents";
import { rangeWindow, type MetricRange } from "./metricModel";
import { CARD_BUCKETS, changeRange, rangeChange } from "./metricSeries";
import { WatchCard } from "./WatchCard";
import { drawnFor } from "./watchDrawn";
import type { OpsWatch } from "./opsTypes";

/** The window an inline card reads: the overview's default. */
const RANGE: MetricRange = "7d";

export default function MetricRefCard({ watch }: { watch: OpsWatch & { provider?: string | null; group_short_id?: string | null; group_last_transition?: string | null; group_last_transition_at?: number | null } }) {
  const now = useCoarseNow(60_000);
  const cRange = changeRange(RANGE);
  const series = useWatchSeries(watch._id, { kind: "range", range: RANGE }, CARD_BUCKETS);
  const prev = useWatchSeries(watch._id, { kind: "prev", range: cRange }, CARD_BUCKETS);
  const drawn = drawnFor(watch, series, rangeWindow(RANGE, [], now));
  const change = rangeChange(series, prev, watch.points, RANGE, now);
  const since = currentEpisodeSince(watch, { last_transition: watch.group_last_transition ?? undefined, last_transition_at: watch.group_last_transition_at ?? undefined });
  return (
    <div className="min-w-0 max-w-[560px]" data-entity-card="metric">
      <WatchCard
        watch={watch}
        range={RANGE}
        drawn={drawn}
        change={change}
        now={now}
        since={since}
        issue={watch.group_short_id ?? undefined}
        provider={(watch.provider ?? undefined) as any}
        cursor={false}
      />
    </div>
  );
}
