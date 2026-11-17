// A task's predicted effect on a goal metric, read back after ship (ct-96177,
// shared/contracts/predictedEffect.ts). The prediction and its reading both
// live on the task; a goal lists its predictions from its tasks
// (by_workspace_prediction), so the record has one home.
//
// The sweep (crons.ts) takes predictions whose `due_at` has come: a task
// that has not shipped is looked at again a day later, a dropped one or one
// that never ships within PREDICTION_READ.never_shipped_days reads as
// unreadable, and a shipped one is read at its read time against the window
// before ship.
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { metricNumber, type InitiativeMetric } from "@codecast/shared/contracts/initiative";
import {
  judgePrediction,
  parsePrediction,
  predictionReadAt,
  predictionWindows,
  PREDICTION_READ,
  type PredictedEffect,
  type RealisedEffect,
  type WindowPoint,
} from "@codecast/shared/contracts/predictedEffect";
import { readSeries } from "./lib/metricPoints";
import { watchIn } from "./lib/metricSeries";
import { patchTask } from "./lib/taskWrite";

const DAY = 86_400_000;
const SWEEP_BATCH = 50;

type StoredPrediction = PredictedEffect & { due_at?: number };
type Metric = InitiativeMetric & { noise?: string };

const initiativeOf = (goalRef: string) => goalRef.split(":")[0];
const keyOf = (goalRef: string) => goalRef.split(":").slice(1).join(":");

async function goalIn(ctx: { db: any }, workspace: string | undefined, goalRef: string): Promise<Doc<"initiatives"> | null> {
  const row = await ctx.db.query("initiatives").withIndex("by_short_id", (q: any) => q.eq("short_id", initiativeOf(goalRef))).first();
  return row && workspace && row.workspace === workspace ? row : null;
}

/**
 * The patch that sets (or with "" clears) a task's prediction, after checking
 * it names a metric of a goal in the task's own workspace. A new prediction
 * drops any earlier reading.
 */
export async function predictionPatch(ctx: { db: any }, task: Pick<Doc<"tasks">, "workspace" | "short_id">, text: string, now: number): Promise<{ predicted: StoredPrediction | undefined; realised: undefined }> {
  if (!text.trim()) return { predicted: undefined, realised: undefined };
  const parsed = parsePrediction(text, now);
  if ("error" in parsed) throw new Error(parsed.error);
  const p = parsed.prediction;
  const goal = await goalIn(ctx, task.workspace, p.goal_ref);
  if (!goal) throw new Error(`No goal ${initiativeOf(p.goal_ref)} in ${task.short_id}'s workspace (cast goals lists them)`);
  const metric = (goal.metrics ?? []).find((m: InitiativeMetric) => m.key === keyOf(p.goal_ref));
  if (!metric) throw new Error(`${goal.short_id} has no metric "${keyOf(p.goal_ref)}"; its metrics: ${(goal.metrics ?? []).map((m: InitiativeMetric) => m.key).join(", ") || "none"}`);
  const due_at = p.read_at ?? now + p.read_days! * DAY;
  return { predicted: { ...p, ...(metric.series ? { series: metric.series } : {}), due_at }, realised: undefined };
}

/** When a task went live: the watch's start for a line ship, else when it closed done. Null while it is not done. */
export const shippedAt = (task: Pick<Doc<"tasks">, "status" | "watch_from" | "closed_at">): number | null =>
  task.status === "done" ? task.watch_from ?? task.closed_at ?? null : null;

/** The metric's values in [from, to]: its live series' points, else the goal's reported values. */
async function windowPoints(ctx: { db: any }, source: { watch: Doc<"metric_watches"> } | { reports: WindowPoint[] }, [from, to]: [number, number]): Promise<WindowPoint[]> {
  if ("reports" in source) return source.reports.filter((p) => p.at >= from && p.at <= to);
  const answer = await readSeries(ctx, source.watch, from, to, 200);
  return answer.points.map((p) => ({ at: p.at, value: p.value, n: p.n }));
}

type ReadOutcome = { realised: RealisedEffect } | { due_at: number };

/** What the sweep does with one due prediction: read it now, or name when to look again. */
export async function readPrediction(ctx: { db: any }, task: Doc<"tasks">, now: number): Promise<ReadOutcome> {
  const p = task.predicted as StoredPrediction;
  const unreadable = (note: string, shipped: number | null = null): ReadOutcome => ({
    realised: { verdict: "unreadable", value_before: null, value_after: null, delta: null, within_noise: null, band: null, shipped_at: shipped, from: null, to: null, read_at: now, note },
  });
  if (task.status === "dropped") return unreadable("The task was dropped before it shipped");
  const shipped = shippedAt(task);
  if (shipped === null) {
    if (now - p.set_at > PREDICTION_READ.never_shipped_days * DAY) return unreadable(`The task had not shipped ${PREDICTION_READ.never_shipped_days} days after the prediction`);
    return { due_at: now + PREDICTION_READ.recheck_days * DAY };
  }
  const readAt = predictionReadAt(p, shipped);
  if (readAt > now) return { due_at: readAt };
  const goal = await goalIn(ctx, task.workspace, p.goal_ref);
  if (!goal) return unreadable(`Goal ${initiativeOf(p.goal_ref)} is gone from this workspace`, shipped);
  const metric = (goal.metrics ?? []).find((m: Metric) => m.key === keyOf(p.goal_ref)) as Metric | undefined;
  const seriesRef = metric ? metric.series : p.series;
  const watch = seriesRef ? await watchIn(ctx, goal.workspace, seriesRef) : null;
  const history = metric ? goal.score_history?.[metric.key] ?? [] : [];
  if (!watch && !history.length) {
    return unreadable(metric ? `${goal.short_id}'s ${metric.name} has no live series or reported values to read` : `${goal.short_id} no longer has the metric ${keyOf(p.goal_ref)}`, shipped);
  }
  const source = watch
    ? { watch }
    : { reports: history.flatMap((s: { value: string; observed_at: number }) => { const n = metricNumber(s.value); return n === null ? [] : [{ at: s.observed_at, value: n }]; }) };
  const windows = predictionWindows(shipped, readAt);
  const before = await windowPoints(ctx, source, [windows.before[0], windows.before[1] - 1]);
  const after = await windowPoints(ctx, source, windows.after);
  const judged = judgePrediction(p, { before, after, noise: metric?.noise ?? null });
  return { realised: { ...judged, shipped_at: shipped, from: windows.after[0], to: windows.after[1], read_at: now, source: watch ? watch.short_id : `${goal.short_id} reports` } };
}

/** One pass over predictions that are due; true when more are waiting. */
export async function readDuePredictions(ctx: { db: any }, now: number): Promise<{ read: number; deferred: number; more: boolean }> {
  const due: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_prediction_due", (q: any) => q.gt("predicted.due_at", 0).lte("predicted.due_at", now)).take(SWEEP_BATCH);
  let read = 0, deferred = 0;
  for (const task of due) {
    if (!task.predicted) continue;
    const outcome = await readPrediction(ctx, task, now);
    const { due_at: _was, ...kept } = task.predicted as StoredPrediction;
    if ("realised" in outcome) {
      await patchTask(ctx, task, { predicted: kept, realised: outcome.realised, updated_at: now });
      read++;
    } else {
      // Only the queue key moves, which no surface shows: updated_at stays, so no client re-fetches the row.
      await patchTask(ctx, task, { predicted: { ...kept, due_at: outcome.due_at } });
      deferred++;
    }
  }
  return { read, deferred, more: due.length === SWEEP_BATCH };
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const result = await readDuePredictions(ctx, Date.now());
    if (result.more) await ctx.scheduler.runAfter(0, internal.predictions.sweep, {});
    return result;
  },
});
