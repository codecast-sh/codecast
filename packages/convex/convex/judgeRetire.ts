// A judge's findings withdrawn by a newer judging of the same moment
// (docs/architecture/learning-loop.md LL8). When a moment is judged again (a
// later judge version, a moment re-read with its window), the judge's earlier
// findings on it that the new run did not find again leave their problems: a
// board keeps only what the current judge stands behind. A problem left with
// no findings, and no run working it, closes with a note saying why.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";

/** Problem statuses a run is working or has finished: those keep their state and only lose the finding. */
const WORKED = new Set(["in_progress", "in_review", "done", "dropped"]);

/**
 * Retire the findings earlier runs of this judge filed from this moment, all
 * but those whose key the new run found again (`keep`).
 */
export const retireSuperseded = internalMutation({
  args: { moment_id: v.id("moments"), judge: v.string(), judge_version: v.string(), keep: v.array(v.string()), before: v.number(), actor: v.id("users") },
  handler: async (ctx, args) => {
    const runs = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", args.moment_id)).collect())
      .filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.at < args.before && r.signal_ids?.length);
    const keep = new Set(args.keep);
    const ids = [...new Set(runs.flatMap((r: Doc<"judge_runs">) => (r.signal_ids ?? []).map(String)))] as Id<"signals">[];
    const rows = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter((s): s is Doc<"signals"> => !!s && !s.retired && !keep.has(s.fingerprint));
    return await retireSignals(ctx, rows, {
      reason: `judged again by ${args.judge} ${args.judge_version.slice(0, 8)}, which did not find it`,
      judge_version: args.judge_version,
      actor: args.actor,
    });
  },
});

export async function retireSignals(ctx: any, rows: Doc<"signals">[], o: { reason: string; judge_version?: string; actor: Id<"users"> }) {
  const now = Date.now();
  const byTask = new Map<string, Doc<"signals">[]>();
  for (const row of rows) {
    await ctx.db.patch(row._id, {
      task_id: undefined,
      retired: { at: now, reason: o.reason, ...(row.task_id ? { task_id: row.task_id } : {}), ...(o.judge_version ? { judge_version: o.judge_version } : {}) },
    });
    if (row.task_id) byTask.set(String(row.task_id), [...(byTask.get(String(row.task_id)) ?? []), row]);
  }
  const closed: string[] = [];
  for (const [taskId, gone] of byTask) {
    const task: Doc<"tasks"> | null = await ctx.db.get(taskId as Id<"tasks">);
    if (!task?.cause) continue;
    const left: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    const keys = new Set(left.map((s) => s.fingerprint));
    await ctx.db.patch(task._id, {
      cause: { ...task.cause, signal_count: left.length, fingerprints: task.cause.fingerprints.filter((k) => keys.has(k) || !gone.some((g) => g.fingerprint === k)) },
      updated_at: now,
    });
    const what = gone.length === 1 ? "1 finding" : `${gone.length} findings`;
    if (left.length === 0 && !WORKED.has(task.status)) {
      await moveTaskStatus(ctx, (await ctx.db.get(task._id))!, "dropped", { actorUserId: o.actor, actorType: "system", now });
      await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Closed: its ${what} were judged again and none held (${o.reason}).` });
      closed.push(task.short_id);
    }
  }
  return { retired: rows.length, problems: byTask.size, closed };
}
