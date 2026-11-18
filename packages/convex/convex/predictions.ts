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
import { deltaPhrase, expandCases, pairedDelta } from "@codecast/shared/contracts/envs";
import {
  judgeEnvPrediction,
  judgePrediction,
  parsePrediction,
  predictionReadAt,
  predictionWindows,
  predictionSpanMs,
  readability,
  readingPeriodMs,
  targetKind,
  unreadableWords,
  PREDICTION_READ,
  type PredictedEffect,
  type RealisedEffect,
  type WindowPoint,
} from "@codecast/shared/contracts/predictedEffect";
import { readSeries } from "./lib/metricPoints";
import { watchIn } from "./lib/metricSeries";
import { patchTask } from "./lib/taskWrite";
import { DEFAULT_READ_SPAN_MS, metricPeriodOf, targetSense } from "./lib/predictionTargets";

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
 * its target is in the task's own workspace. It records the goal the target
 * serves (else the goal the task is grounded on) and whether the target can
 * detect a move this size over the read. A prediction is stated before ship:
 * one written after would be scored on what already happened. A new
 * prediction drops any earlier reading.
 */
export async function predictionPatch(ctx: { db: any }, task: Pick<Doc<"tasks">, "workspace" | "short_id"> & Partial<Pick<Doc<"tasks">, "status" | "closed_at" | "goal_ref">>, text: string, now: number): Promise<{ predicted: StoredPrediction | undefined; realised: undefined }> {
  if (!text.trim()) return { predicted: undefined, realised: undefined };
  const parsed = parsePrediction(text, now);
  if ("error" in parsed) throw new Error(parsed.error);
  const shipped = task.status ? shippedAt(task as Pick<Doc<"tasks">, "status" | "closed_at">) : null;
  if (shipped !== null) throw new Error(`${task.short_id} shipped ${isoDay(shipped)}; a prediction is stated before ship, so the read cannot see the result first`);
  const p = parsed.prediction;
  if (!task.workspace) throw new Error(`${task.short_id} has no workspace to read a prediction in`);
  const sense = await targetSense(ctx, task.workspace, p.goal_ref, predictionSpanMs(p, now));
  if ("error" in sense) throw new Error(sense.error);
  const grounded = /^in-\d+:/.test(task.goal_ref ?? "") ? task.goal_ref!.split(":")[0] : undefined;
  const goal = sense.goal ?? grounded;
  const due_at = p.read_at ?? (p.read_days !== undefined ? now + p.read_days * DAY : now + PREDICTION_READ.recheck_days * DAY);
  return { predicted: { ...p, ...(sense.series ? { series: sense.series } : {}), ...(goal ? { goal } : {}), ...readability(p, sense.mde, sense.level), due_at }, realised: undefined };
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
    // A revisit: the reading stands while the ship it read stands; a later ship, or a first one after a
    // reading that found none (dropped, never shipped), is read on its own.
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
  const kind = targetKind(p.goal_ref);
  const read = kind === "env" ? await readEnv(ctx, task, p, shipped, now) : await readSeriesTarget(ctx, task, p, shipped, readAt);
  if (!("judged" in read)) {
    if ("wait" in read) return now - shipped > PREDICTION_READ.never_shipped_days * DAY ? unreadable(read.wait, shipped) : { due_at: now + PREDICTION_READ.recheck_days * DAY };
    return unreadable(read.missing, shipped);
  }
  const realised: RealisedEffect = { ...read.judged, shipped_at: shipped, from: read.from, to: read.to, read_at: now, source: read.source };
  // Smaller than the target can see: what it did is kept, and it teaches nothing either way.
  const unreadableHere = unreadableWords(p);
  return { realised: unreadableHere ? { ...realised, verdict: "unreadable", note: `${capital(unreadableHere)}; ${realised.note}` } : realised };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
type Read = { judged: ReturnType<typeof judgePrediction>; from: number | null; to: number | null; source: string } | { missing: string } | { wait: string };

/** A goal metric or a series: the window after ship against as long before it, from the live series (else the goal's reports). */
async function readSeriesTarget(ctx: { db: any }, task: Doc<"tasks">, p: StoredPrediction, shipped: number, readAt: number): Promise<Read> {
  const ws = task.workspace!;
  let metric: Metric | undefined;
  let history: Array<{ value: string; observed_at: number }> = [];
  let owner = p.goal_ref;
  if (targetKind(p.goal_ref) === "metric") {
    const goal = await goalIn(ctx, ws, p.goal_ref);
    if (!goal) return { missing: `Goal ${initiativeOf(p.goal_ref)} is gone from this workspace` };
    owner = goal.short_id;
    metric = (goal.metrics ?? []).find((m: Metric) => m.key === keyOf(p.goal_ref)) as Metric | undefined;
    history = metric ? goal.score_history?.[metric.key] ?? [] : [];
    if (!metric && !p.series) return { missing: `${goal.short_id} no longer has the metric ${keyOf(p.goal_ref)}` };
  } else {
    // A series reads the noise model of the metric that names it.
    const sense = await targetSense(ctx, ws, p.goal_ref, DEFAULT_READ_SPAN_MS);
    if (!("error" in sense)) metric = sense.metric;
  }
  // The series the prediction was made against wins over whatever the metric reads now.
  const seriesRef = p.series ?? metric?.series;
  const watch = seriesRef ? await watchIn(ctx, ws, seriesRef) : null;
  if (!watch && !history.length) return { missing: `${owner}'s ${metric?.name ?? seriesRef ?? p.goal_ref} has no live series or reported values to read` };
  const source = watch
    ? { watch }
    : { reports: history.flatMap((s) => { const n = metricNumber(s.value); return n === null ? [] : [{ at: s.observed_at, value: n }]; }) };
  const windows = predictionWindows(shipped, readAt);
  const before = await windowPoints(ctx, source, [windows.before[0], windows.before[1] - 1]);
  const after = await windowPoints(ctx, source, windows.after);
  const independent = (windows.after[1] - windows.after[0]) / (metric ? metricPeriodOf(metric, watch) : readingPeriodMs(undefined, watch?.unit));
  const judged = judgePrediction(p, { before, after, noise: metric?.noise ?? null, independent });
  return { judged, from: windows.after[0], to: windows.after[1], source: watch ? watch.short_id : `${owner} reports` };
}

/** An env: its first attempt after ship paired against its last attempt before, over the cases both scored when both kept them. */
async function readEnv(ctx: { db: any }, task: Doc<"tasks">, p: StoredPrediction, shipped: number, now: number): Promise<Read> {
  const env = p.goal_ref.slice(4);
  const rows: Doc<"env_attempts">[] = await ctx.db.query("env_attempts").withIndex("by_workspace_env", (q: any) => q.eq("workspace", task.workspace).eq("env", env).lte("finished_at", now)).order("desc").take(200);
  const before = rows.find((a) => a.finished_at <= shipped);
  const after = [...rows].reverse().find((a) => a.finished_at > shipped && (!before || a.split === before.split));
  if (!before) return { missing: `${env} has no attempt before ship to compare with` };
  if (!after) return { wait: `${env} had no attempt after ship within ${PREDICTION_READ.never_shipped_days} days` };
  const cases = async (a: Doc<"env_attempts">) => {
    const stored = await ctx.db.query("env_attempt_cases").withIndex("by_attempt", (q: any) => q.eq("attempt_id", a._id)).first();
    return stored ? expandCases(JSON.parse(stored.cases)) : [];
  };
  const [b, c] = await Promise.all([cases(before), cases(after)]);
  const paired = b.length && c.length ? pairedDelta(b, c) : null;
  const half = (ci?: number[]) => (ci && ci.length === 2 ? (ci[1]! - ci[0]!) / 2 : null);
  const read = paired && paired.n > 0
    ? { before: before.mean, after: after.mean, delta: paired.delta, half: half(paired.ci95), note: `${deltaPhrase(paired)} (${before.short_id} to ${after.short_id})` }
    : { before: before.mean, after: after.mean, delta: after.mean - before.mean, half: half(before.ci95) !== null && half(after.ci95) !== null ? Math.hypot(half(before.ci95)!, half(after.ci95)!) : null, note: `means ${before.mean.toFixed(3)} to ${after.mean.toFixed(3)}, unpaired (${before.short_id} to ${after.short_id})` };
  return { judged: judgeEnvPrediction(p, read), from: after.finished_at, to: after.finished_at, source: `env:${env} ${before.short_id}→${after.short_id}` };
}

/** Read one leased prediction and write what the read says. */
export async function readOnePrediction(ctx: { db: any }, taskId: Id<"tasks">, now: number): Promise<ReadOutcome | null> {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task?.predicted) return null;
  const outcome = await readPrediction(ctx, task, now);
  const { due_at: _was, ...kept } = task.predicted as StoredPrediction;
  if ("realised" in outcome) {
    const revisit = { due_at: now + (outcome.realised.shipped_at === null ? PREDICTION_READ.recheck_days * DAY : REVISIT_EVERY) };
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

/**
 * One pass of the backfill for predictions written before they named their
 * goal: a goal metric's goal is its initiative. Run until it reports 0:
 * `npx convex run predictions:backfillGoal` (or the dashboard).
 */
export const backfillGoal = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<"tasks">[] = await ctx.db.query("tasks").withIndex("by_prediction_due", (q: any) => q.gt("predicted.due_at", 0)).take(2000);
    let fixed = 0;
    for (const t of rows) {
      const p = t.predicted as StoredPrediction;
      if (p.goal || targetKind(p.goal_ref) !== "metric") continue;
      await ctx.db.patch(t._id, { predicted: { ...p, goal: initiativeOf(p.goal_ref) } });
      fixed++;
    }
    return { fixed };
  },
});
