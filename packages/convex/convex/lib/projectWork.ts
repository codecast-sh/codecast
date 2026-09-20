import type { Id } from "../_generated/dataModel";
import { projectTaskCounts, type ProjectProgress } from "@codecast/shared/tasks";
import { canAccessTask } from "./access";

// A project's progress as the board states it (shared/tasks
// projectTaskCounts): the tasks that name the project and that the project's
// board would show, done over the rest. The rule lives in shared so the
// initiative page, the role page and `cast initiative show` print one number;
// this only adds what a server read must add, the caller's access.

type Ctx = { db: any };

/** The tasks that name the project, the ones the caller may read. */
export async function projectTasks(ctx: Ctx, userId: Id<"users">, projectId: Id<"projects">): Promise<any[]> {
  const rows = await ctx.db.query("tasks").withIndex("by_project_id", (q: any) => q.eq("project_id", projectId)).collect();
  const out: any[] = [];
  for (const task of rows) if (await canAccessTask(ctx, userId, task)) out.push(task);
  return out;
}

export async function projectProgress(ctx: Ctx, userId: Id<"users">, projectId: Id<"projects">): Promise<ProjectProgress> {
  return projectTaskCounts(await projectTasks(ctx, userId, projectId), [projectId]);
}
