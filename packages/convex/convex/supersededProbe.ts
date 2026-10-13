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
    // The stacks of the person's teams (a trial's cards live in its stack, not the queue).
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", user._id)).collect();
    for (const m of memberships) {
      const stacks: Doc<"decision_stacks">[] = await ctx.db.query("decision_stacks").withIndex("by_team", (q: any) => q.eq("team_id", m.team_id)).collect();
      for (const st of stacks) {
        if (st.status !== "open") continue;
        for (const id of st.decision_ids) { const d = await ctx.db.get(id); if (d && d.status === "pending") rows.set(String(d._id), d); }
      }
    }
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
        // The gate and its presenter as the run recorded them, to compare with a graph about to be published.
        ran_producers: run?.graph_nodes && d.gate_node_id ? run.graph_nodes.filter((n) => n.id === d.gate_node_id || n.id === workflow?.nodes.find((x) => x.id === d.gate_node_id)?.asker) : null,
        superseded: await decisionSuperseded(ctx, d),
        created_at: new Date(d.created_at).toISOString().slice(0, 16),
      });
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { pending: out.length, hidden: out.filter((r) => r.superseded).length, rows: out };
  },
});
