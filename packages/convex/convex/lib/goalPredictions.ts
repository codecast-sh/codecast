// A goal's predictions, read from the tasks that state them (predictions.ts
// writes them). A leaf with no function definitions, so the role card and the
// brief (lib/roleInitiatives) read it without importing a module of writes.
import type { Doc } from "../_generated/dataModel";
import { hitRateWords, predictionTally, predictionWords, type GoalPredictionRow, type PredictedEffect, type PredictionTally, type RealisedEffect } from "@codecast/shared/contracts/predictedEffect";
import { seriesLookup } from "./metricSeries";

const GOAL_LIST_MAX = 200;

/** The tasks in the goal's workspace that predict an effect on one of its metrics. */
async function predictionTasks(ctx: { db: any }, goal: { short_id: string; workspace: string }): Promise<Doc<"tasks">[]> {
  const rows: Doc<"tasks">[] = await ctx.db
    .query("tasks")
    .withIndex("by_workspace_prediction", (q: any) => q.eq("workspace", goal.workspace).gte("predicted.goal_ref", `${goal.short_id}:`).lt("predicted.goal_ref", `${goal.short_id};`))
    .take(GOAL_LIST_MAX);
  return rows.filter((t) => t.predicted);
}

/** "4 of 9 predictions held, 2 open" for a goal, or empty when none of its tasks predicts anything. */
export async function goalHitRate(ctx: { db: any }, goal: { short_id: string; workspace: string }): Promise<string> {
  return hitRateWords(predictionTally(await predictionTasks(ctx, goal)));
}

/** A goal's predictions, the latest read or set first, with the unit of the metric each names. */
export async function goalPredictions(ctx: { db: any }, goal: Pick<Doc<"initiatives">, "short_id" | "workspace" | "metrics" | "scoreboard">): Promise<{ rows: GoalPredictionRow[]; tally: PredictionTally; hit_rate: string; partial: boolean }> {
  const tasks = await predictionTasks(ctx, goal);
  const lookup = await seriesLookup(ctx, goal.workspace, [goal]);
  const units = new Map((goal.metrics ?? []).map((m) => [m.key, (m.series ? lookup(m.series)?.unit : null) ?? null]));
  const rows: GoalPredictionRow[] = tasks
    .map((t) => {
      const { due_at: _d, ...predicted } = t.predicted as PredictedEffect & { due_at?: number };
      const realised = (t.realised as RealisedEffect | undefined) ?? null;
      const unit = units.get(predicted.goal_ref.split(":").slice(1).join(":")) ?? null;
      return { short_id: t.short_id, title: t.title, status: t.status, predicted, realised, unit, ...predictionWords(predicted, realised, unit) };
    })
    .sort((a, b) => (b.realised?.read_at ?? b.predicted.set_at) - (a.realised?.read_at ?? a.predicted.set_at));
  const tally = predictionTally(rows);
  return { rows, tally, hit_rate: hitRateWords(tally), partial: tasks.length >= GOAL_LIST_MAX };
}
