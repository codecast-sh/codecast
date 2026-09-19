import type { Id } from "../_generated/dataModel";
import { canAccessTask } from "./access";

// The tasks of a project, in the contract's order (initiatives-projects-
// role-page.md): plans and tasks are inside projects, so a task that names no
// project of its own belongs to its plan's project. The web's role scope view
// (lib/roleScope.ts) counts the same way; this is the server side of that one
// rule, so the initiative page, the role page and `cast initiative show`
// agree on a project's progress.

type Ctx = { db: any };

/** Every task of the project the caller may read, each once. */
export async function projectTasks(ctx: Ctx, userId: Id<"users">, projectId: Id<"projects">): Promise<any[]> {
  const direct = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", projectId)).collect();
  const plans = await ctx.db.query("plans").withIndex("by_project_id", (q: any) => q.eq("project_id", projectId)).collect();
  const viaPlan = (await Promise.all(plans.map((plan: any) =>
    ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect(),
  ))).flat().filter((t: any) => !t.project_id);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const task of [...direct, ...viaPlan]) {
    if (seen.has(String(task._id))) continue;
    seen.add(String(task._id));
    if (await canAccessTask(ctx, userId, task)) out.push(task);
  }
  return out;
}

/** Progress as every surface states it: done over everything that is not dropped. */
export function taskCounts(tasks: readonly { status?: string }[]): { total: number; done: number } {
  const live = tasks.filter((t) => t.status !== "dropped");
  return { total: live.length, done: live.filter((t) => t.status === "done").length };
}
