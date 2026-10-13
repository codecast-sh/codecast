// Read-only: what the superseded rule hides from one person's decisions and
// their trial stacks, and why (docs/architecture/line-versions.md). Run with
// packages/convex/run.sh supersededProbe:forUser '{"email":"..."}'.
import { v } from "convex/values";
import { internalQuery } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { decisionSuperseded, gateLineChange } from "./lib/superseded";

export const forUser = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user: Doc<"users"> | null = await ctx.db.query("users").withIndex("email", (q: any) => q.eq("email", args.email)).first();
    if (!user) return { error: "no such user" };
    const rows = new Map<string, Doc<"session_decisions">>();
    const inbox = await ctx.db.query("decision_inbox").withIndex("by_user_status", (q: any) => q.eq("user_id", user._id).eq("status", "pending")).collect();
    for (const r of inbox) { const d = await ctx.db.get(r.decision_id); if (d && d.status === "pending") rows.set(String(d._id), d); }
    const own: Doc<"session_decisions">[] = await ctx.db.query("session_decisions").withIndex("by_user_status", (q: any) => q.eq("user_id", user._id).eq("status", "pending")).collect();
    for (const d of own) rows.set(String(d._id), d);
    const out = [];
    for (const d of rows.values()) {
      const run: Doc<"workflow_runs"> | null = d.workflow_run_id ? await ctx.db.get(d.workflow_run_id) : null;
      const workflow: Doc<"workflows"> | null = run?.workflow_id ? await ctx.db.get(run.workflow_id) : null;
      const task: Doc<"tasks"> | null = d.task_id ? await ctx.db.get(d.task_id) : null;
      out.push({
        decision: d.short_id ?? String(d._id),
        question: d.question.slice(0, 90),
        trial: !!(d as any).trial,
        task: task?.short_id ?? null,
        gate: d.gate_node_id ?? null,
        run_status: run?.status ?? null,
        run_gate: run?.gate_node_id ?? null,
        graph: workflow ? `${workflow.slug}${workflow.origin ? "" : " (no origin)"}` : null,
        ran_recorded: !!run?.graph_nodes,
        line_changed: run ? await gateLineChange(ctx, run, workflow) : null,
        superseded: await decisionSuperseded(ctx, d),
        created_at: new Date(d.created_at).toISOString().slice(0, 16),
      });
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { pending: out.length, hidden: out.filter((r) => r.superseded).length, rows: out };
  },
});
