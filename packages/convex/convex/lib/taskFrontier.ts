// How a task is picked up and run (docs/architecture/task-graph.md TG7-TG9):
// the ready frontier's order, the execution hints a spawn reads, and the quiet
// that ephemeral bookkeeping keeps. The ordering rule is shared/tasks'
// frontierOrder; this module reads the plans it needs from the database.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { TASK_EFFORTS, frontierOrder } from "@codecast/shared/tasks";

type ReadCtx = Pick<QueryCtx, "db">;

/** `tasks` in frontier order: live before stale, priority, plan order, oldest. */
export async function orderFrontier<T extends Doc<"tasks">>(ctx: ReadCtx, tasks: T[], now: number): Promise<T[]> {
  const planIds = [...new Set(tasks.flatMap((t) => (t.plan_id ? [t.plan_id] : [])))];
  const plans = await Promise.all(planIds.map((id) => ctx.db.get(id)));
  const position = new Map<string, number>();
  for (const plan of plans) (plan?.task_ids ?? []).forEach((id, i) => position.set(String(id), i));
  return frontierOrder(tasks, { now, planPosition: (t) => position.get(String(t._id)) });
}

/** A notification about this entity would be about ephemeral bookkeeping
 *  (TG9), which stays out of the bell and the phone. */
export async function isEphemeralTask(ctx: ReadCtx, entityType: string, entityId: string): Promise<boolean> {
  if (entityType !== "task") return false;
  const id = ctx.db.normalizeId("tasks", entityId);
  return !!(id && (await ctx.db.get(id as Id<"tasks">))?.ephemeral);
}

/** Who a comment on this task reaches. Ephemeral bookkeeping is quiet (TG9),
 *  but a blocker it raises or a person it @mentions is attention a person
 *  must see, so those still reach the thread and the bell. */
export function commentReaches<T>(task: { ephemeral?: boolean }, commentType: string, recipients: T[], mentioned: Set<string>): T[] {
  if (!task.ephemeral || commentType === "blocker") return recipients;
  return recipients.filter((r) => mentioned.has(String(r)));
}

/**
 * The execution hints a task update takes (TG8, TG9): `model` and `effort`
 * ("" clears either) and `ephemeral` (false is `cast task keep`). One set of
 * validators for the CLI's update and the web's, so the two cannot drift.
 */
export const executionHintArgs = {
  model: v.optional(v.string()),
  effort: v.optional(v.union(v.literal(""), ...TASK_EFFORTS.map((e) => v.literal(e)))),
  ephemeral: v.optional(v.boolean()),
};

export function executionHintPatch(args: { model?: string; effort?: string; ephemeral?: boolean }): Partial<Pick<Doc<"tasks">, "model" | "effort" | "ephemeral">> {
  const patch: Record<string, unknown> = {};
  if (args.model !== undefined) patch.model = args.model.trim() || undefined;
  if (args.effort !== undefined) patch.effort = args.effort || undefined;
  if (args.ephemeral !== undefined) patch.ephemeral = args.ephemeral || undefined;
  return patch;
}
