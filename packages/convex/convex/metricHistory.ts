// A watch's history read, the body of metrics.readHistory: volume counters,
// an app connector's reader, or PostHog, each recorded through
// metrics.recordHistory. Kept apart from metrics.ts so the action's queue
// stays there and this module registers nothing.
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./functions";
import { connFor, fetchMetricHistory } from "./sources/posthog";
import { readAppMetric } from "./sources/appMetrics";
import { isTokenRefusal } from "./lib/sourceHealth";
import { METRIC_WATCH_LIMITS } from "@codecast/shared/contracts/ingest";

/** One watch's history read (readHistory without the queue). */
export async function readOneHistory(ctx: ActionCtx, args: { watch_id: Id<"metric_watches">; days?: number }): Promise<{ added?: number; note?: string } | null> {
  const watch = await ctx.runQuery(internal.metrics.historyInputs, { watch_id: args.watch_id });
  if (!watch) return null;
  if (watch.query_kind === "volume") {
    // The counters reach back as far as they keep (48 hours of events, 30 days of issues); open issues has no past.
    const read = await ctx.runQuery(internal.metrics.volumeRead, { watch_id: args.watch_id, history: true });
    if (!read?.points?.length) {
      const note = read?.error ?? "Its source keeps no past for this series; the history is its polls";
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
      return { note };
    }
    return await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points });
  }
  if (watch.query_kind === "reader") {
    // The reader answers its own series with every read; `days` asks for more when it takes one.
    const read = await readAppMetric(ctx, watch.source_id, watch.query, fetch, { days: args.days ?? METRIC_WATCH_LIMITS.backfill_days_default });
    if (!read.ok) {
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note: read.error });
      return { note: read.error };
    }
    if (!read.points.length) {
      const note = "The reader answers no dated points; the history is its polls";
      await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
      return { note };
    }
    return await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points, ...(read.version ? { version: read.version } : {}) });
  }
  const source = await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: watch.source_id });
  if (!source || source.status !== "active") {
    const note = source ? `The source is ${source.status}` : "The source was removed";
    await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note });
    return { note };
  }
  const conn = await connFor(ctx, source);
  const span = { now: Date.now(), oldest: watch.oldest, interval_ms: watch.interval_ms, days: args.days ?? METRIC_WATCH_LIMITS.backfill_days_default };
  const read = "error" in conn ? { ok: false as const, error: conn.error, lost: true } : await fetchMetricHistory(conn, watch, span);
  if (read.ok) {
    const added = await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, points: read.points, ...(read.note ? { note: read.note } : {}) });
    return { ...added, ...(read.note ? { note: read.note } : {}) };
  }
  await ctx.runMutation(internal.metrics.recordHistory, { watch_id: args.watch_id, note: read.error });
  if ("lost" in read || isTokenRefusal(read.status)) {
    await ctx.runMutation(internal.ingest.sourceConnectionLost, { source_id: source.source_id, error: read.error });
  }
  return { note: read.error };
}
