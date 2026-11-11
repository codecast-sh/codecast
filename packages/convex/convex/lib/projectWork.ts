import type { Id } from "../_generated/dataModel";
import type { ProjectProgress } from "@codecast/shared/tasks";
import { canAccessTask } from "./access";
import { projectCountsFor } from "./projectTaskCounts";

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

/**
 * The project's tasks in the given status categories. With a `limit`, each
 * status is read newest touched first and stops once `limit` rows pass `keep`
 * and the caller's access, so a list never reads the whole project: 10k
 * unfinished rows under one project cost 41 MB a call and timed out (Union
 * triage, 2026-11-10). `triage` names the triage states to read (undefined is
 * a row with none), so a list without mined rows skips them in the index.
 * Without a limit, every row of those statuses is read.
 */
export async function projectTasksIn(
  ctx: Ctx,
  userId: Id<"users">,
  projectId: Id<"projects">,
  statuses: readonly string[],
  opts: { limit?: number; triage?: readonly (string | undefined)[]; keep?: (task: any) => boolean | Promise<boolean> } = {},
): Promise<any[]> {
  const tasks = () => ctx.db.query("tasks");
  const ranges = statuses.flatMap((status) => opts.triage
    ? opts.triage.map((triage) => tasks().withIndex("by_project_triage_status_updated", (q: any) => q.eq("project_id", projectId).eq("triage_status", triage).eq("status", status)))
    : [tasks().withIndex("by_project_status_updated", (q: any) => q.eq("project_id", projectId).eq("status", status))]);
  const out: any[] = [];
  for (const range of ranges) {
    let taken = 0;
    for await (const task of range.order("desc")) {
      if (opts.keep && !(await opts.keep(task))) continue;
      if (!(await canAccessTask(ctx, userId, task))) continue;
      out.push(task);
      if (opts.limit !== undefined && ++taken >= opts.limit) break;
    }
  }
  return out;
}

/** The same number, from project_task_counts rather than the tasks. */
export async function projectProgress(ctx: Ctx, userId: Id<"users">, projectId: Id<"projects">): Promise<ProjectProgress> {
  return (await projectCountsFor(ctx, userId, [projectId])).get(String(projectId))!;
}
