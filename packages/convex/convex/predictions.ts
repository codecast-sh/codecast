// A task's predicted effect on a goal metric, read back after ship (ct-96177,
// shared/contracts/predictedEffect.ts). The prediction and its reading both
// live on the task; a goal lists its predictions from its tasks, so the record
// has one home (lib/goalPredictions.ts).
//
// `due_at` on the prediction is the sweep's queue key. The hourly sweep
// (crons.ts) leases each due prediction an hour ahead and reads it in its own
// mutation, so one heavy or failing read never holds back the rest. A read
// either writes the reading or names when to look again: a task not shipped is
// looked at daily, one that never ships reads as unreadable, and a read task is
// revisited weekly for a while, so a reopen and a second ship replace the
// reading of the first.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { metricNumber, type InitiativeMetric } from "@codecast/shared/contracts/initiative";
import {
  judgePrediction,
  parsePrediction,
  predictionReadAt,
  predictionWindows,
  readingPeriodMs,
  PREDICTION_READ,
  type PredictedEffect,
  type RealisedEffect,
  type WindowPoint,
} from "@codecast/shared/contracts/predictedEffect";
import { readSeries } from "./lib/metricPoints";
import { watchIn } from "./lib/metricSeries";
import { patchTask } from "./lib/taskWrite";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SWEEP_BATCH = 50;
/** A read task is looked at again this often, for this long, in case it is reopened and shipped again. */
const REVISIT_EVERY = 7 * DAY;
const REVISIT_FOR = 60 * DAY;

type StoredPrediction = PredictedEffect & { due_at?: number };
type Metric = InitiativeMetric & { noise?: string; window?: string };

const initiativeOf = (goalRef: string) => goalRef.split(":")[0];
const keyOf = (goalRef: string) => goalRef.split(":").slice(1).join(":");
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function goalIn(ctx: { db: any }, workspace: string | undefined, goalRef: string): Promise<Doc<"initiatives"> | null> {
  const row = await ctx.db.query("initiatives").withIndex("by_short_id", (q: any) => q.eq("short_id", initiativeOf(goalRef))).first();
  return row && workspace && row.workspace === workspace ? row : null;
}

/** When a task went live: when it closed done (the line stamps its ship there; a reopen clears it). Null while it is not done. */
export const shippedAt = (task: Pick<Doc<"tasks">, "status" | "closed_at">): number | null =>
  task.status === "done" ? task.closed_at ?? null : null;

/**
 * The patch that sets (or with "" clears) a task's prediction, after checking
 * it names a metric of a goal in the task's own workspace. A prediction is
 * stated before ship: one written after would be scored on what already
 * happened. A new prediction drops any earlier reading.
 */
export async function predictionPatch(ctx: { db: any }, task: Pick<Doc<"tasks">, "workspace" | "short_id"> & Partial<Pick<Doc<"tasks">, "status" | "closed_at">>, text: string, now: number): Promise<{ predicted: StoredPrediction | undefined; realised: undefined }> {
  if (!text.trim()) return { predicted: undefined, realised: undefined };
  const parsed = parsePrediction(text, now);
  if ("error" in parsed) throw new Error(parsed.error);
  const shipped = task.status ? shippedAt(task as Pick<Doc<"tasks">, "status" | "closed_at">) : null;
  if (shipped !== null) throw new Error(`${task.short_id} shipped ${isoDay(shipped)}; a prediction is stated before ship, so the read cannot see the result first`);
  const p = parsed.prediction;
  const goal = await goalIn(ctx, task.workspace, p.goal_ref);
  if (!goal) throw new Error(`No goal ${initiativeOf(p.goal_ref)} in ${task.short_id}'s workspace (cast goals lists them)`);
  const metric = (goal.metrics ?? []).find((m: InitiativeMetric) => m.key === keyOf(p.goal_ref));
  if (!metric) throw new Error(`${goal.short_id} has no metric "${keyOf(p.goal_ref)}"; its metrics: ${(goal.metrics ?? []).map((m: InitiativeMetric) => m.key).join(", ") || "none"}`);
  const due_at = p.read_at ?? now + p.read_days! * DAY;
  return { predicted: { ...p, ...(metric.series ? { series: metric.series } : {}), due_at }, realised: undefined };
}

/** The metric's values in [from, to]: its live series' points, else the goal's reported values. */
async function windowPoints(ctx: { db: any }, source: { watch: Doc<"metric_watches"> } | { reports: WindowPoint[] }, [from, to]: [number, number]): Promise<WindowPoint[]> {
  if ("reports" in source) return source.reports.filter((p) => p.at >= from && p.at <= to);
  const answer = await readSeries(ctx, source.watch, from, to, 200);
  return answer.points.map((p) => ({ at: p.at, value: p.value, n: p.n }));
}

/** What a read does: write a reading, look again later (clearing an old reading when the task left the ship it described), or stop. */
export type ReadOutcome = { realised: RealisedEffect } | { due_at: number; clear?: boolean } | { stop: true };

/** Read one prediction now, or say when to look again. */
export async function readPrediction(ctx: { db: any }, task: Doc<"tasks">, now: number): Promise<ReadOutcome> {
  const p = task.predicted as StoredPrediction;
  const shipped = shippedAt(task);
  const prior = task.realised as RealisedEffect | undefined;
  if (prior) {
    // A revisit: the reading stands while the ship it read stands; a second ship is read on its own.
    if (prior.shipped_at === null) return { stop: true };
    if (shipped !== null && shipped !== prior.shipped_at) return { due_at: predictionReadAt(p, shipped), clear: true };
    if (now - prior.read_at > REVISIT_FOR) return { stop: true };
    return { due_at: now + (shipped === null ? PREDICTION_READ.recheck_days * DAY : REVISIT_EVERY) };
  }
  const unreadable = (note: string, at: number | null = null): ReadOutcome => ({
    realised: { verdict: "unreadable", value_before: null, value_after: null, delta: null, within_noise: null, band: null, shipped_at: at, from: null, to: null, read_at: now, note },
  });
  if (task.status === "dropped") return unreadable("The task was dropped");
  if (shipped === null) {
    if (now - p.set_at > PREDICTION_READ.never_shipped_days * DAY) return unreadable(`The task had not shipped ${PREDICTION_READ.never_shipped_days} days after the prediction`);
    return { due_at: now + PREDICTION_READ.recheck_days * DAY };
  }
  const readAt = predictionReadAt(p, shipped);
  if (readAt > now) return { due_at: readAt };
  const goal = await goalIn(ctx, task.workspace, p.goal_ref);
  if (!goal) return unreadable(`Goal ${initiativeOf(p.goal_ref)} is gone from this workspace`, shipped);
  const metric = (goal.metrics ?? []).find((m: Metric) => m.key === keyOf(p.goal_ref)) as Metric | undefined;
  // The series the prediction was made against wins over whatever the metric reads now.
  const seriesRef = p.series ?? metric?.series;
  const watch = seriesRef ? await watchIn(ctx, goal.workspace, seriesRef) : null;
  const history = metric ? goal.score_history?.[metric.key] ?? [] : [];
  if (!watch && !history.length) {
    return unreadable(metric || seriesRef ? `${goal.short_id}'s ${metric?.name ?? seriesRef} has no live series or reported values to read` : `${goal.short_id} no longer has the metric ${keyOf(p.goal_ref)}`, shipped);
  }
  const source = watch
    ? { watch }
    : { reports: history.flatMap((s: { value: string; observed_at: number }) => { const n = metricNumber(s.value); return n === null ? [] : [{ at: s.observed_at, value: n }]; }) };
  const windows = predictionWindows(shipped, readAt);
  const before = await windowPoints(ctx, source, [windows.before[0], windows.before[1] - 1]);
  const after = await windowPoints(ctx, source, windows.after);
  const independent = (windows.after[1] - windows.after[0]) / readingPeriodMs(metric, watch?.unit);
  const judged = judgePrediction(p, { before, after, noise: metric?.noise ?? null, independent });
  return { realised: { ...judged, shipped_at: shipped, from: windows.after[0], to: windows.after[1], read_at: now, source: watch ? watch.short_id : `${goal.short_id} reports` } };
}

/** Read one leased prediction and write what the read says. */
export async function readOnePrediction(ctx: { db: any }, taskId: Id<"tasks">, now: number): Promise<ReadOutcome | null> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task?.predicted) return null;
  const outcome = await readPrediction(ctx, task, now);
  const { due_at: _was, ...kept } = task.predicted as StoredPrediction;
  if ("realised" in outcome) {
    const revisit = outcome.realised.shipped_at !== null ? { due_at: now + REVISIT_EVERY } : {};
    await patchTask(ctx, task, { predicted: { ...kept, ...revisit }, realised: outcome.realised, updated_at: now });
  } else if ("stop" in outcome) {
    await patchTask(ctx, task, { predicted: kept });
  } else if (outcome.clear) {
    await patchTask(ctx, task, { predicted: { ...kept, due_at: outcome.due_at }, realised: undefined, updated_at: now });
  } else {
    // Only the queue key moves, which no surface shows: updated_at stays, so no client re-fetches the row.
    await patchTask(ctx, task, { predicted: { ...kept, due_at: outcome.due_at } });
  }
  return outcome;
}

/** Lease up to one batch of due predictions an hour ahead, so a read that fails is tried again next hour and never blocks the others. */
export async function leaseDuePredictions(ctx: { db: any }, now: number): Promise<{ ids: Id<"tasks">[]; more: boolean }> {
  const due: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_prediction_due", (q: any) => q.gt("predicted.due_at", 0).lte("predicted.due_at", now)).take(SWEEP_BATCH);
  for (const task of due) await ctx.db.patch(task._id, { predicted: { ...(task.predicted as StoredPrediction), due_at: now + HOUR } });
  return { ids: due.map((t) => t._id), more: due.length === SWEEP_BATCH };
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const { ids, more } = await leaseDuePredictions(ctx, now);
    for (const task_id of ids) await ctx.scheduler.runAfter(0, internal.predictions.readOne, { task_id });
    if (more) await ctx.scheduler.runAfter(0, internal.predictions.sweep, {});
    return { leased: ids.length };
  },
});

export const readOne = internalMutation({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, { task_id }) => {
    await readOnePrediction(ctx, task_id, Date.now());
  },
});
