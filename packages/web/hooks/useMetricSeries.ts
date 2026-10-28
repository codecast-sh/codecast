// The live series goals and projects read their numbers from
// (contracts/initiative InitiativeMetric.series): the workspace's metric
// watches, from their one home in the store (opsWatches). A surface that
// shows a goal's or a project's numbers mounts the feeder once and reads the
// lookup, so every surface and the role's brief read the same value.
import { useMemo } from "react";
import type { MetricSeries } from "@codecast/shared/contracts/initiative";
import { useOpsWatches, useSyncOpsWatches } from "./useSyncOps";
import type { OpsWatch } from "../components/ops/opsTypes";

export type SeriesLookup = (ref: string) => MetricSeries | undefined;

const asSeries = (w: OpsWatch): MetricSeries => ({ short_id: w.short_id, name: w.name, unit: w.unit ?? null, points: w.points, last_error: w.last_error ?? null });

/** The workspace's watches, kept fed. Mount it where numbers are shown. */
export const useSyncMetricSeries = useSyncOpsWatches;

/** The series a metric names, by short id; and the watches, for a picker. */
export function useMetricSeries(): { lookup: SeriesLookup; watches: OpsWatch[] } {
  const watches = useOpsWatches();
  return useMemo(() => {
    const byRef = new Map(watches.map((w) => [w.short_id, asSeries(w)]));
    return { lookup: (ref: string) => byRef.get(ref), watches };
  }, [watches]);
}
