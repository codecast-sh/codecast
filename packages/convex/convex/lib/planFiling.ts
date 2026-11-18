// A plan's tasks live in the plan's project. A task created under a plan takes
// the plan's project, and filing the plan somewhere else carries its open
// tasks along, so coverage, project counts and goal progress (all keyed by
// task.project_id) see plan work. A task whose own project differs from the
// plan's was filed on purpose and keeps it.

import { Id } from "../_generated/dataModel";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

type Ctx = { db: any };

/** The project a new task under `planId` takes when it names none itself. */
export async function projectFromPlan(ctx: Ctx, planId: Id<"plans"> | undefined): Promise<Id<"projects"> | undefined> {
  if (!planId) return undefined;
  const plan = await ctx.db.get(planId);
  return plan?.project_id ?? undefined;
}

/** Open tasks under the plan that follow it: no project, or the plan's current one. */
export async function planTasksThatFollow(ctx: Ctx, plan: { _id: Id<"plans">; project_id?: Id<"projects"> }): Promise<any[]> {
  const tasks = await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect();
  const from = String(plan.project_id ?? "");
  return tasks.filter((t: any) => !isTerminalTaskStatus(t.status) && (!t.project_id || String(t.project_id) === from));
}

/**
 * File a plan under a project: the plan row, its doc, and the open tasks that
 * follow it. Refiling into the plan's current project still picks up tasks
 * that never took it. Access and same-workspace checks are the caller's.
 */
export async function filePlanUnderProject(
  ctx: Ctx,
  plan: { _id: Id<"plans">; project_id?: Id<"projects">; doc_id?: Id<"docs"> },
  projectId: Id<"projects">,
  now = Date.now(),
): Promise<{ tasks_moved: number }> {
  const moving = (await planTasksThatFollow(ctx, plan)).filter((t) => String(t.project_id ?? "") !== String(projectId));
  if (String(plan.project_id ?? "") !== String(projectId)) {
    await ctx.db.patch(plan._id, { project_id: projectId, updated_at: now });
    if (plan.doc_id) {
      const doc = await ctx.db.get(plan.doc_id);
      if (doc) await ctx.db.patch(doc._id, { project_id: projectId, updated_at: now });
    }
  }
  for (const t of moving) await ctx.db.patch(t._id, { project_id: projectId, updated_at: now });
  return { tasks_moved: moving.length };
}
