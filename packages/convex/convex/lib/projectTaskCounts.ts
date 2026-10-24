import type { Id } from "../_generated/dataModel";
import { isOnProjectBoard, type ProjectProgress } from "@codecast/shared/tasks";
import { heldKeysFor } from "./accessKeys";

// Per-project task counts without reading the project's tasks. A project can
// hold thousands of tasks (12k on prod), and counting them per list call read
// tens of MB and timed out `cast project ls`. One project_task_counts row holds
// how many of a project's tasks sit in one (workspace, status) bucket; the write
// interceptor (changeLog.ts) moves a task between buckets on every write, and a
// reader sums the buckets whose workspace key it holds.
//
// Only rows the project's board shows are counted (shared/tasks
// isOnProjectBoard), so every surface prints the board's number.
//
// Backfill and live writes share one cursor (project_task_count_state): a task
// created at or before `through` has been counted by the backfill, so the
// interceptor keeps it current; a later one is left for the backfill to reach.
// Both read the state row, so OCC orders them and no task is counted twice.

type Db = { db: any };
type Bucket = { project_id: Id<"projects">; workspace: string; status: string };

/** Fields whose change can move a task between buckets. */
export const COUNT_FIELDS = new Set([
  "project_id", "workspace", "status", "triage_status", "source", "promoted", "assignee", "ephemeral",
]);

export function touchesProjectCount(fields: Record<string, unknown>): boolean {
  return Object.keys(fields).some((k) => COUNT_FIELDS.has(k));
}

export function countBucket(task: any): Bucket | null {
  if (!task?.project_id || !isOnProjectBoard(task)) return null;
  return { project_id: task.project_id, workspace: task.workspace ?? "", status: task.status ?? "" };
}

const sameBucket = (a: Bucket | null, b: Bucket | null) =>
  a === b || (!!a && !!b && String(a.project_id) === String(b.project_id) && a.workspace === b.workspace && a.status === b.status);

export async function countState(ctx: Db): Promise<{ _id?: any; through: number; done: boolean }> {
  return (await ctx.db.query("project_task_count_state").first()) ?? { through: 0, done: false };
}

async function bump(ctx: Db, b: Bucket, delta: number): Promise<void> {
  const row = await ctx.db
    .query("project_task_counts")
    .withIndex("by_bucket", (q: any) => q.eq("project_id", b.project_id).eq("workspace", b.workspace).eq("status", b.status))
    .first();
  if (row) await ctx.db.patch(row._id, { count: Math.max(0, row.count + delta) });
  else if (delta > 0) await ctx.db.insert("project_task_counts", { ...b, count: delta });
}

/** Move one task from its pre-write bucket to its post-write one. `ctx.db` is
 *  the raw writer: count rows are not tracked tables. */
export async function moveProjectCount(ctx: Db, pre: any | null, post: any | null): Promise<void> {
  const from = countBucket(pre);
  const to = countBucket(post);
  if (sameBucket(from, to)) return;
  const task = post ?? pre;
  const state = await countState(ctx);
  if (!state.done && !(task._creationTime <= state.through)) return;
  if (from) await bump(ctx, from, -1);
  if (to) await bump(ctx, to, 1);
}

/** One backfill page: count the next tasks past the cursor and advance it. */
export async function backfillProjectCountsPage(ctx: Db, numItems: number): Promise<{ scanned: number; done: boolean }> {
  const state = await countState(ctx);
  if (state.done) return { scanned: 0, done: true };
  const page = await ctx.db
    .query("tasks")
    .withIndex("by_creation_time", (q: any) => q.gt("_creationTime", state.through))
    .take(numItems);
  const totals = new Map<string, { b: Bucket; n: number }>();
  for (const task of page) {
    const b = countBucket(task);
    if (!b) continue;
    const key = `${b.project_id}|${b.workspace}|${b.status}`;
    const cur = totals.get(key) ?? { b, n: 0 };
    cur.n++;
    totals.set(key, cur);
  }
  for (const { b, n } of totals.values()) await bump(ctx, b, n);
  const done = page.length < numItems;
  const next = { through: page.length ? page[page.length - 1]._creationTime : state.through, done };
  if (state._id) await ctx.db.patch(state._id, next);
  else await ctx.db.insert("project_task_count_state", next);
  return { scanned: page.length, done };
}

/** Drop every count and rewind the cursor, so the backfill recounts from zero. */
export async function resetProjectCounts(ctx: Db): Promise<number> {
  const rows = await ctx.db.query("project_task_counts").collect();
  for (const r of rows) await ctx.db.delete(r._id);
  const state = await ctx.db.query("project_task_count_state").first();
  if (state) await ctx.db.patch(state._id, { through: 0, done: false });
  return rows.length;
}

/** Board progress per project, counting the buckets `userId` may read. Access
 *  is the workspace key; a task's owner who has left its team no longer counts
 *  it here, which canAccessTask would still allow. */
export async function projectCountsFor(
  ctx: Db,
  userId: Id<"users">,
  projectIds: Id<"projects">[],
): Promise<Map<string, ProjectProgress>> {
  const held = await heldKeysFor(ctx, userId);
  const out = new Map<string, ProjectProgress>();
  for (const projectId of projectIds) {
    const p: ProjectProgress = { total: 0, done: 0, in_progress: 0, open: 0 };
    const rows = await ctx.db.query("project_task_counts").withIndex("by_bucket", (q: any) => q.eq("project_id", projectId)).collect();
    for (const r of rows) {
      if (!held.has(r.workspace) || !r.count) continue;
      p.total += r.count;
      if (r.status === "done") p.done += r.count;
      else if (r.status === "in_progress" || r.status === "in_review") p.in_progress += r.count;
      else p.open += r.count;
    }
    out.set(String(projectId), p);
  }
  return out;
}
