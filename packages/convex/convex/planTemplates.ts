// `cast plan template save <plan>` (docs/architecture/task-graph.md TG6): a
// plan worth repeating keeps its steps and edges as a plan_templates row, and
// `cast plan create --template <name>` writes them again through the ordinary
// create paths. A template carries the plan's workspace as its team_id: the
// owner alone for a personal plan, the team for a team plan (plans.ts
// createFromTemplate reads it the same way).

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessPlan, canAccessTask, isSameWorkspace, workspaceForResource } from "./lib/access";
import { notFound } from "./lib/auth";
import { templateSteps } from "@codecast/shared/tasks";

export const save = mutation({
  args: {
    api_token: v.string(),
    plan: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const plan = await ctx.db.query("plans").withIndex("by_short_id", (q) => q.eq("short_id", args.plan)).first();
    if (!plan || !(await canAccessPlan(ctx, auth.userId, plan))) notFound(`Plan not found: ${args.plan}`);
    const workspace = workspaceForResource(plan!);
    const tasks: Doc<"tasks">[] = [];
    for (const id of plan!.task_ids ?? []) {
      const t = await ctx.db.get(id);
      if (t && t.status !== "dropped" && isSameWorkspace(t, workspace) && (await canAccessTask(ctx, auth.userId, t))) tasks.push(t);
    }
    if (!tasks.length) throw new Error(`${plan!.short_id} has no steps to save`);

    const task_templates = templateSteps(tasks).map(({ task, blocked_by_indices }) => ({
      title: task.title,
      ...(task.description ? { description: task.description } : {}),
      ...(task.task_type ? { task_type: task.task_type } : {}),
      ...(task.priority ? { priority: task.priority } : {}),
      ...(blocked_by_indices.length ? { blocked_by_indices } : {}),
      ...(task.estimated_minutes ? { estimated_minutes: task.estimated_minutes } : {}),
    }));
    const name = args.name?.trim() || plan!.title;
    const team_id = workspace.type === "team" ? (workspace.teamId as Id<"teams">) : undefined;
    const now = Date.now();
    const row = {
      name,
      team_id,
      description: args.description?.trim() || undefined,
      goal_template: plan!.goal,
      task_templates,
      updated_at: now,
    };
    // One template per name in a workspace: saving again replaces it.
    const existing = (await ctx.db.query("plan_templates").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect())
      .find((t) => t.name === name && String(t.team_id ?? "") === String(team_id ?? ""));
    const id = existing
      ? (await ctx.db.patch(existing._id, row), existing._id)
      : await ctx.db.insert("plan_templates", { ...row, user_id: auth.userId, created_at: now });
    const edges = task_templates.reduce((n, t) => n + (t.blocked_by_indices?.length ?? 0), 0);
    return { id, name, steps: task_templates.length, edges, replaced: !!existing };
  },
});

/** `cast plan template rm <name>`: only the person who saved it removes it. */
export const remove = mutation({
  args: { api_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const own = await ctx.db.query("plan_templates").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect();
    const matches = own.filter((t) => t.name.toLowerCase() === args.name.trim().toLowerCase());
    if (!matches.length) notFound(`No template of yours named "${args.name}"`);
    for (const t of matches) await ctx.db.delete(t._id);
    return { removed: matches.length };
  },
});

/** The templates the caller may instantiate: their own, and their teams'. */
export const list = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const own = await ctx.db.query("plan_templates").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect();
    const memberships = await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect();
    const team = (await Promise.all(memberships.map((m) =>
      ctx.db.query("plan_templates").withIndex("by_team_id", (q) => q.eq("team_id", m.team_id)).collect(),
    ))).flat();
    const seen = new Set<string>();
    return [...own, ...team]
      .filter((t) => !seen.has(String(t._id)) && seen.add(String(t._id)))
      .sort((a, b) => b.updated_at - a.updated_at);
  },
});
