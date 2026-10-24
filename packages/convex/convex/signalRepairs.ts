// One-off repairs of findings and the problems they reopened, run by hand
// (packages/convex/run.sh signalRepairs:<name>), each with a dry run.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { evidenceAt, momentEvidence, retireOnClose } from "./findingGroups";

const noteOn = (ctx: any, taskId: Id<"tasks">, text: string) => insertTaskComment(ctx, taskId, { author: "line", comment_type: "note", text });

/**
 * One-off repair (run with packages/convex/run.sh): record when the fix went
 * live on problems a line dissolved before closes carried it, so evidence
 * from after the fix reopens them (findingGroups.recursAfterFix). Only a
 * dissolved problem in the workspace is stamped; `dry` reports only.
 */
export const stampDissolvedFixes = internalMutation({
  args: { workspace: v.string(), fixes: v.array(v.object({ task: v.string(), fixed_at: v.number() })), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const out: Array<{ task: string; stamped: boolean; why?: string }> = [];
    for (const fix of args.fixes) {
      const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", fix.task)).first();
      if (!task || task.workspace !== args.workspace || !task.cause?.dissolved) {
        out.push({ task: fix.task, stamped: false, why: !task ? "not found" : task.workspace !== args.workspace ? "other workspace" : "not dissolved" });
        continue;
      }
      if (!args.dry) await ctx.db.patch(task._id, { cause: { ...task.cause, dissolved: { ...task.cause.dissolved, fixed_at: fix.fixed_at } } });
      out.push({ task: fix.task, stamped: !args.dry });
    }
    return out;
  },
});

/**
 * One-off repair (run with packages/convex/run.sh): put back problems that a
 * finding which cannot date what it saw reopened as "the fix did not hold"
 * (reopenAfterFix) before bulk reviews filed their findings undated
 * (findingGroups.momentEvidence). Each named problem is read from its own
 * record: the finding that reopened it, the fix day its reopen note names,
 * and the close and note its dissolve wrote. One the new rule would still
 * reopen, or that a run has taken up since, is left alone and listed. A
 * restored problem goes back to done through the task status path with its
 * dissolve, its findings retire as at the close, and a note answers the
 * reopen. `dry` reports only.
 */
export const restoreUndatedReopens = internalMutation({
  args: { workspace: v.string(), tasks: v.array(v.string()), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const out: Array<Record<string, unknown>> = [];
    for (const ref of args.tasks) {
      const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      const skip = (why: string, more: Record<string, unknown> = {}) => out.push({ task: ref, restored: false, why, ...more });
      if (!task || task.workspace !== args.workspace) { skip(!task ? "not found" : "other workspace"); continue; }
      if (task.status !== "open" || task.cause?.dissolved) { skip(`status ${task.status}${task.cause?.dissolved ? ", dissolved" : ""}: not as the reopen left it`); continue; }
      const comments: Doc<"task_comments">[] = await ctx.db.query("task_comments").withIndex("by_task_created", (q: any) => q.eq("task_id", task._id)).collect();
      const reopen = comments.filter((c) => /^Reopened: the fix live since \d{4}-\d\d-\d\d did not hold\./.test(c.text)).at(-1);
      if (!reopen) { skip("no \"the fix did not hold\" reopen"); continue; }
      const day = reopen.text.match(/since (\d{4}-\d\d-\d\d)/)![1];
      // The note names the day only: the end of it, so nothing from the fix's own day counts against it.
      const fixedAt = Date.parse(`${day}T23:59:59.999Z`);
      const reopener = (await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect())
        .filter((r: Doc<"signals">) => r.reopened && r.created_at <= reopen.created_at).sort((a: Doc<"signals">, b: Doc<"signals">) => b.created_at - a.created_at)[0];
      if (!reopener) { skip("the finding that reopened it is no longer on it"); continue; }
      const moment: Doc<"moments"> | null = reopener.moment ? await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", reopener.moment)).first() : null;
      const happened = moment ? momentEvidence(moment).happened_after : reopener.happened_after;
      const at = evidenceAt({ observed_at: reopener.observed_at, happened_after: happened });
      if (at === undefined || at > fixedAt) { skip(`${reopener.short_id} is dated after the fix: a real recurrence`); continue; }
      const run: Doc<"workflow_runs"> | null = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
      if (run && run.created_at > reopen.created_at) { skip("a run started since the reopen", { run: String(run._id), run_status: run.status }); continue; }
      const history: Doc<"task_history">[] = await ctx.db.query("task_history").withIndex("by_task_id", (q: any) => q.eq("task_id", task._id)).collect();
      const close = history.filter((h) => h.field === "status" && h.new_value === "done" && h.created_at < reopen.created_at).sort((a, b) => b.created_at - a.created_at)[0];
      if (!close) { skip("no close before the reopen"); continue; }
      // dissolveForCli notes its reason in the same transaction as the close.
      const note = comments.slice(0, comments.indexOf(reopen)).filter((c) => c.author === "line" && c.comment_type === "note" && Math.abs(c.created_at - close.created_at) < 5_000).at(-1)?.text;
      if (!note) { skip("no dissolve note at the close"); continue; }
      const plan = { task: ref, restored: !args.dry, finding: reopener.short_id, moment: reopener.moment ?? null, fixed_at: new Date(fixedAt).toISOString(), closed_at: new Date(close.created_at).toISOString(), note: note.slice(0, 120) };
      out.push(plan);
      if (args.dry) continue;
      if (happened !== undefined) await ctx.db.patch(reopener._id, { happened_after: happened, reopened: undefined });
      await moveTaskStatus(ctx, task, "done", { actorUserId: task.user_id, now, closedAt: close.created_at, extra: { cause: { ...task.cause!, dissolved: { at: close.created_at, note, fixed_at: fixedAt } } } });
      await retireOnClose(ctx, (await ctx.db.get(task._id))!, now);
      await noteOn(ctx, task._id, `Reopen undone: ${reopener.short_id} came from a review of ${reopener.moment ?? "a whole history"}, which cannot date what it found, so it does not show the fix live since ${day} failing. Closed again as dissolved.`);
    }
    return out;
  },
});

/**
 * One-off repair (run with packages/convex/run.sh, paging with `cursor`):
 * stamp the findings bulk reviews filed before they were filed undated
 * (findingGroups.momentEvidence), so moving or regrouping one never reopens
 * a fixed problem. `dry` counts only.
 */
export const stampUndatedFindings = internalMutation({
  args: { workspace: v.string(), cursor: v.optional(v.union(v.string(), v.null())), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("signals").withIndex("by_workspace_created", (q: any) => q.eq("workspace", args.workspace)).paginate({ cursor: args.cursor ?? null, numItems: 300 });
    const batches = new Map<string, boolean>();
    let stamped = 0;
    for (const row of page.page as Doc<"signals">[]) {
      if (!row.moment || row.happened_after !== undefined) continue;
      if (!batches.has(row.moment)) batches.set(row.moment, !!(await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", row.moment)).first())?.batch);
      if (!batches.get(row.moment)) continue;
      stamped++;
      if (!args.dry) await ctx.db.patch(row._id, { happened_after: 0 });
    }
    return { scanned: page.page.length, stamped, cursor: page.isDone ? null : page.continueCursor };
  },
});
