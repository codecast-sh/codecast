// The live series goals and projects read their numbers from
// (contracts/initiative InitiativeMetric.series): the workspace's metric
// watches, from their one home in the store (opsWatches). A surface that
// shows a goal's or a project's numbers mounts the feeder once and reads the
// lookup, so every surface and the role's brief read the same value. A metric
// read over a window (contracts/metricStanding) needs more than the row's
// newest points: its watches' last 30 days at card size, the same answer the
// Metrics overview's 30d cards read (opsWatchSeries), ride along as history,
// and the whole of a watch's history at card size when a window reaches past
// those 30 days. The server reads the window's slots from the raw points
// (convex/lib/metricSeries seriesLookup); these are bucket means, so a band
// edge right at the target can read differently here than in a brief.
import { useMemo } from "react";
import type { MetricSeries } from "@codecast/shared/contracts/initiative";
import { metricDenominatorRef, metricPeriodMs, parseMetricWindow } from "@codecast/shared/contracts/metricStanding";
import { useOpsWatches, useSyncOpsWatches } from "./useSyncOps";
import { useSyncEnvStandings } from "./useEnvStandings";
import { useSyncSeriesMany, useWatchSeriesMap } from "./useSyncOpsMetrics";
import { useInitiatives } from "./useInitiatives";
import type { OpsWatch } from "../components/ops/opsTypes";
import type { OpsWatchSeries } from "../components/ops/metricSeries";

export type SeriesLookup = (ref: string) => MetricSeries | undefined;

const WINDOW_RANGE = "30d" as const;
const RECENT_MS = 29 * 86_400_000;

const asSeries = (w: OpsWatch, recent?: OpsWatchSeries, all?: OpsWatchSeries): MetricSeries => {
  const older = all && recent ? all.points.filter((p) => p.at < recent.from) : all?.points ?? [];
  const history = [...older, ...(recent?.points ?? [])].map((p) => ({ at: p.at, value: p.value }));
  return { short_id: w.short_id, name: w.name, unit: w.unit ?? null, points: w.points, last_error: w.last_error ?? null, ...(history.length ? { history } : {}) };
};

/** The workspace's watches, and the standing of every environment its goals name, kept fed. Mount it where numbers are shown. */
export function useSyncMetricSeries() {
  useSyncEnvStandings();
  return useSyncOpsWatches();
}

/** The 30 days of every watch a goal reads over a window. Mounted once, beside useSyncMetricSeries. */
export function useSyncMetricWindows() {
  const initiatives = useInitiatives();
  const watches = useOpsWatches();
  const { ids, far } = useMemo(() => {
    const byRef = new Map(watches.map((w) => [w.short_id, w]));
    const near = new Set<string>(), long = new Set<string>();
    for (const m of initiatives.flatMap((r) => r.metrics ?? [])) {
      const window = parseMetricWindow(m.window);
      const main = m.series ? byRef.get(m.series) : undefined;
      if (!window || !main) continue;
      const period = metricPeriodMs(`${m.name} ${main.name} ${main.unit ?? ""}`, window);
      const reach = (Math.max(1, Math.round(window.ms / period)) - 1) * period;
      for (const ref of [m.series, metricDenominatorRef(m)]) {
        const w = ref ? byRef.get(ref) : undefined;
        if (w) (reach > RECENT_MS ? long : near).add(w._id);
      }
    }
    return { ids: [...new Set([...near, ...long])].sort(), far: [...long].sort() };
  }, [initiatives, watches]);
  useSyncSeriesMany(ids, WINDOW_RANGE);
  useSyncSeriesMany(far, "all");
}

/** The series a metric names, by short id; and the watches, for a picker. */
export function useMetricSeries(): { lookup: SeriesLookup; watches: OpsWatch[] } {
  const watches = useOpsWatches();
  const recent = useWatchSeriesMap(WINDOW_RANGE);
  const all = useWatchSeriesMap("all");
  return useMemo(() => {
    const byRef = new Map(watches.map((w) => [w.short_id, asSeries(w, recent.get(w._id), all.get(w._id))]));
    return { lookup: (ref: string) => byRef.get(ref), watches };
  }, [watches, recent, all]);
}
