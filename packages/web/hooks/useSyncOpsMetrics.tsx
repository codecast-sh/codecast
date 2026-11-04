// A watch's values over a window (metrics.series, metrics.seriesMany) into
// opsWatchSeries, keyed by components/ops/metricModel seriesKey, and the
// readers the Metrics views paint from. The watch row's own newest values
// paint first; an answer for the window replaces them when it lands.
import { useCallback, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useOpsScope } from "./useSyncOps";
import { CARD_BUCKETS, changeRange, rangeMs, seriesArgs, seriesKey, type MetricRange, type OpsWatchSeries, type SeriesSpec } from "../components/ops/metricModel";

const api = _api as any;

/** How many watches one overview read carries (metrics.seriesMany takes up to 30). */
const MANY_CHUNK = 20;

function withScope(scope: ReturnType<typeof useOpsScope>, args: Record<string, unknown> | null): Record<string, unknown> | "skip" {
  return scope === "skip" || !args ? "skip" : { ...scope, ...args };
}

const seriesSig = (r: OpsWatchSeries) => `${r.to}|${r.from}|${r.points.length}|${r.points[r.points.length - 1]?.value ?? ""}|${r.held_from ?? ""}`;

/** One watch's values for one window: feeds the store and reads it back. */
export function useWatchSeries(watchId: string | null, spec: SeriesSpec | null, buckets: number): OpsWatchSeries | undefined {
  return useWatchSeriesLive(watchId, spec, buckets).series;
}

/**
 * The same, and whether the server has answered on this mount (`live`): a
 * row the store held from an earlier visit paints, but only a live answer
 * may say a window holds nothing.
 */
export function useWatchSeriesLive(watchId: string | null, spec: SeriesSpec | null, buckets: number): { series: OpsWatchSeries | undefined; live: boolean } {
  const scope = useOpsScope();
  const key = watchId && spec ? seriesKey(watchId, spec, buckets) : null;
  const args = useMemo(
    () => (watchId && spec ? withScope(scope, ((a) => (a ? { watch: watchId, ...a } : null))(seriesArgs(spec, buckets))) : "skip"),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key spells the watch, the window and the buckets
    [scope, key],
  );
  const select = useMemo(() => ({ select: (d: any) => (d && key ? [{ ...d, _id: key, watch_id: String(d.watch_id) }] : null) }), [key]);
  const { ready } = useSyncCollection("opsWatchSeries", api.metrics.series, args, select);
  const where = useCallback((r: OpsWatchSeries) => r._id === key, [key]);
  const series = useCollectionRows<OpsWatchSeries>("opsWatchSeries", { where, sig: seriesSig })[0];
  return { series, live: ready && !!series };
}

/**
 * What the store already holds for one watch's window at card size (the
 * overview's answer), read without asking the server: the watch page paints
 * from it while its own finer answer is on the way.
 */
export function useHeldSeries(watchId: string | null, spec: SeriesSpec | null): OpsWatchSeries | undefined {
  const key = watchId && spec ? seriesKey(watchId, spec, CARD_BUCKETS) : null;
  const where = useCallback((r: OpsWatchSeries) => r._id === key, [key]);
  return useCollectionRows<OpsWatchSeries>("opsWatchSeries", { where, sig: seriesSig })[0];
}

function ManyChunk({ ids, range, kind }: { ids: string[]; range: MetricRange; kind: "range" | "prev" }) {
  const scope = useOpsScope();
  const joined = ids.join(",");
  const windowArgs = useMemo(() => {
    if (kind === "prev") return seriesArgs({ kind: "prev", range }, CARD_BUCKETS);
    const ms = rangeMs(range);
    return ms === null ? { buckets: CARD_BUCKETS } : { span_ms: ms, buckets: CARD_BUCKETS };
  }, [kind, range]);
  const args = useMemo(
    () => withScope(scope, { watches: ids, ...windowArgs }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joined spells the ids
    [scope, joined, windowArgs],
  );
  const select = useMemo(
    () => ({ select: (d: any) => (Array.isArray(d) ? d.map((s: any) => ({ ...s, _id: seriesKey(String(s.watch_id), { kind, range }, CARD_BUCKETS), watch_id: String(s.watch_id) })) : null) }),
    [kind, range],
  );
  useSyncCollection("opsWatchSeries", api.metrics.seriesMany, args, select);
  return null;
}

/**
 * The overview's feeders: one read per chunk of watches for the range, and
 * the reads the change every card shows needs (changeRange: All reads its
 * change off the 7d range and the 7d before it, as the watch page does). Mount once.
 */
export function WatchSeriesFeeders({ ids, range }: { ids: string[]; range: MetricRange }) {
  const cRange = changeRange(range);
  const chunks = useMemo(() => {
    const sorted = [...ids].sort();
    const out: string[][] = [];
    for (let i = 0; i < sorted.length; i += MANY_CHUNK) out.push(sorted.slice(i, i + MANY_CHUNK));
    return out;
  }, [ids]);
  return (
    <>
      {chunks.map((c) => <ManyChunk key={`${range}:${c[0]}`} ids={c} range={range} kind="range" />)}
      {cRange !== range && chunks.map((c) => <ManyChunk key={`${cRange}:${c[0]}`} ids={c} range={cRange} kind="range" />)}
      {chunks.map((c) => <ManyChunk key={`p${cRange}:${c[0]}`} ids={c} range={cRange} kind="prev" />)}
    </>
  );
}

/** The overview's answers for a range, by watch id. */
export function useWatchSeriesMap(range: MetricRange, kind: "range" | "prev" = "range"): Map<string, OpsWatchSeries> {
  const suffix = `|${kind === "prev" ? "p" : ""}${range}|${CARD_BUCKETS}`;
  const where = useCallback((r: OpsWatchSeries) => r._id.endsWith(suffix), [suffix]);
  const rows = useCollectionRows<OpsWatchSeries>("opsWatchSeries", { where, sig: seriesSig });
  return useMemo(() => new Map(rows.map((r) => [r.watch_id, r])), [rows]);
}
