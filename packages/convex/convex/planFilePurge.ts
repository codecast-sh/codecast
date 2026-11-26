import { v } from "convex/values";
import { internalMutation } from "./functions";

// One-off (2026-11-26): the daemon's ~/.claude/plans watcher, now removed, filed
// each save of a plan file as a new plan bound to whichever session had written
// its transcript last, in that session's workspace. This deletes those plans by
// short id and unbinds their sessions. Their docs were deleted already. Daemons
// keep these short ids cached for their sessions' TaskCreates; tasks.create
// files such a task without a plan. Jason deletes this file once it has run
// (ct-102090).
export const purge = internalMutation({
  args: { short_ids: v.array(v.string()), dry: v.boolean() },
  handler: async (ctx, args) => {
    const report: Array<Record<string, unknown>> = [];
    for (const sid of args.short_ids) {
      const plan = await ctx.db.query("plans").withIndex("by_short_id", (q) => q.eq("short_id", sid)).first();
      if (!plan) { report.push({ sid, missing: true }); continue; }
      if (plan.source !== "plan_mode" || (plan.task_ids?.length ?? 0) > 0) {
        throw new Error(`${sid} is not an empty plan_mode plan`);
      }
      if (plan.doc_id && (await ctx.db.get(plan.doc_id))) throw new Error(`${sid} still has its doc`);
      // A comment or log line is someone's work: the dry run names it, and the real run keeps the plan.
      const logs = Object.fromEntries(
        (["entries", "progress_log", "decision_log", "discoveries", "escalation_log"] as const)
          .map((k) => [k, plan[k]?.length ?? 0])
          .filter(([, n]) => n),
      );
      if (Object.keys(logs).length && !args.dry) throw new Error(`${sid} has log lines: ${JSON.stringify(logs)}`);
      const sessions: Array<Record<string, unknown>> = [];
      for (const cid of plan.session_ids ?? []) {
        const conv = await ctx.db.get(cid);
        if (!conv) continue;
        const active = conv.active_plan_id === plan._id;
        sessions.push({ conversation: cid, was_active: active });
        const reads = await ctx.db
          .query("plan_log_reads")
          .withIndex("by_conversation_plan", (q) => q.eq("conversation_id", cid).eq("plan_id", plan._id))
          .collect();
        if (args.dry) continue;
        await ctx.db.patch(cid, {
          plan_ids: (conv.plan_ids ?? []).filter((p) => p !== plan._id),
          ...(active ? { active_plan_id: undefined } : {}),
        });
        for (const r of reads) await ctx.db.delete(r._id);
      }
      if (!args.dry) await ctx.db.delete(plan._id);
      report.push({ sid, workspace: plan.workspace, sessions, ...(Object.keys(logs).length ? { logs } : {}) });
    }
    return report;
  },
});
