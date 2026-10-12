// What a newer judging of the same moment does to a judge's earlier findings
// (docs/architecture/learning-loop.md LL8). When a moment is judged again (a
// later judge version, a moment re-read with its window), the judge's earlier
// findings on it that the new run did not find again leave their problems: a
// board keeps only what the current judge stands behind. A problem left with
// no findings, and no run working it, closes with a note saying why. A
// finding it did find again takes the newer judge's words, so the board reads
// the way the current judge writes.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

/** Problem statuses a run is working or has finished: those keep their state and only lose the finding. */
const WORKED = new Set(["in_progress", "in_review", "done", "dropped"]);

/**
 * Retire the findings earlier runs of this judge filed from this moment, all
 * but those whose key the new run found again (`keep`). Only findings under
 * an expectation the new run was shown (`shown`) can be found again: one whose
 * judge no longer grades that expectation was not looked for, and stays.
 */
export const retireSuperseded = internalMutation({
  args: { moment_id: v.id("moments"), judge: v.string(), judge_version: v.string(), keep: v.array(v.string()), shown: v.array(v.string()), before: v.number(), actor: v.id("users") },
  handler: async (ctx, args) => {
    const runs = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", args.moment_id)).collect())
      .filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.at < args.before && r.signal_ids?.length);
    const keep = new Set(args.keep);
    const shown = new Set(args.shown);
    const ids = [...new Set(runs.flatMap((r: Doc<"judge_runs">) => (r.signal_ids ?? []).map(String)))] as Id<"signals">[];
    const rows = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
      (s): s is Doc<"signals"> => !!s && !s.retired && !keep.has(s.fingerprint) && !!s.subject && shown.has(s.subject),
    );
    return await retireSignals(ctx, rows, {
      reason: `judged again by ${args.judge} ${args.judge_version.slice(0, 8)}, which did not find it`,
      judge_version: args.judge_version,
      actor: args.actor,
    });
  },
});

const refoundArgs = v.object({ key: v.string(), title: v.string(), detail_md: v.optional(v.string()), severity: v.optional(v.number()) });

/**
 * The findings a live judge's run found again, by evidence key. Each key's
 * live row written by an earlier version of the same judge takes this run's
 * title, detail, severity and version, keeping its problem; a problem titled
 * by that finding's old words takes the new ones. A row an earlier version
 * retired as not found again comes back to its problem while that problem is
 * open. A row another judge wrote keeps its words: two judges read one message,
 * and the first to file it keeps it.
 *
 * Returns the keys that now have a live row (the run files no second copy of
 * those) and the rows that took new words (to be embedded again, and listed
 * on the run as this judge's).
 */
export const refound = internalMutation({
  args: { workspace: v.string(), judge: v.string(), judge_version: v.string(), rows: v.array(refoundArgs) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const live: string[] = [];
    const updated: Array<{ signal_id: Id<"signals">; key: string; revived: boolean }> = [];
    for (const r of args.rows) {
      const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).eq("fingerprint", r.key)).take(20);
      const current = rows.filter((s) => !s.retired);
      let mine = current.filter((s) => s.judge === args.judge && s.judge_version !== args.judge_version);
      let revived = false;
      if (!current.length) {
        const back = await revivable(ctx, rows, args.judge);
        if (!back) continue;
        await ctx.db.patch(back.row._id, { retired: undefined, task_id: back.task._id });
        await recount(ctx, back.task, r.key, now);
        mine = [{ ...back.row, task_id: back.task._id }];
        revived = true;
      }
      live.push(r.key);
      for (const row of mine) {
        await ctx.db.patch(row._id, { title: r.title, detail_md: r.detail_md, ...(r.severity !== undefined ? { severity: r.severity } : {}), judge_version: args.judge_version });
        const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
        if (task && task.title === row.title && task.title !== r.title) await ctx.db.patch(task._id, { title: r.title, updated_at: now });
        updated.push({ signal_id: row._id, key: r.key, revived });
      }
    }
    return { live, updated };
  },
});

/** A row this judge retired as not found again, whose problem is still open. */
async function revivable(ctx: any, rows: Doc<"signals">[], judge: string): Promise<{ row: Doc<"signals">; task: Doc<"tasks"> } | null> {
  for (const row of rows.sort((a, b) => a.created_at - b.created_at)) {
    if (row.judge !== judge || !row.retired?.task_id || !row.retired.reason.startsWith(`judged again by ${judge} `)) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(row.retired.task_id);
    if (task?.cause && !isTerminalTaskStatus(task.status)) return { row, task };
  }
  return null;
}

/** A problem that took a finding back: its count from the findings it holds, and the finding's key. */
async function recount(ctx: any, task: Doc<"tasks">, key: string, now: number) {
  const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const keys = task.cause!.fingerprints;
  await ctx.db.patch(task._id, { cause: { ...task.cause!, signal_count: held.length, fingerprints: keys.includes(key) || keys.length >= 50 ? keys : [...keys, key] }, updated_at: now });
}

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
