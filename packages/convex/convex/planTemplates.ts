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

/** Template names match in any case, everywhere they are looked up. */
const sameTemplateName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The workspace a template belongs to: its team, else its author alone. */
const templateWorkspace = (t: { team_id?: Id<"teams"> | string }) => (t.team_id ? `team:${t.team_id}` : "personal");

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
      if (t && isSameWorkspace(t, workspace) && (await canAccessTask(ctx, auth.userId, t))) tasks.push(t);
    }
    if (!tasks.some((t) => t.status !== "dropped")) throw new Error(`${plan!.short_id} has no steps to save`);

    // Dropped steps stay out, and pass their blockers to the steps that needed them.
    const task_templates = templateSteps(tasks, (t) => t.status === "dropped").map(({ task, blocked_by_indices }) => ({
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
    // One template per name (any case) in a workspace: saving again replaces it.
    const existing = (await ctx.db.query("plan_templates").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect())
      .find((t) => sameTemplateName(t.name, name) && templateWorkspace(t) === templateWorkspace({ team_id }));
    const id = existing
      ? (await ctx.db.patch(existing._id, row), existing._id)
      : await ctx.db.insert("plan_templates", { ...row, user_id: auth.userId, created_at: now });
    const edges = task_templates.reduce((n, t) => n + (t.blocked_by_indices?.length ?? 0), 0);
    return { id, name, steps: task_templates.length, edges, replaced: !!existing };
  },
});

/** `cast plan template rm <name>`: only the person who saved it removes it,
 *  from one workspace. A name saved in several needs `--team` to say which. */
export const remove = mutation({
  args: { api_token: v.string(), name: v.string(), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))), team_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const own = await ctx.db.query("plan_templates").withIndex("by_user_id", (q) => q.eq("user_id", auth.userId)).collect();
    const scope = args.workspace ? templateWorkspace({ team_id: args.workspace === "team" ? args.team_id : undefined }) : undefined;
    const matches = own.filter((t) => sameTemplateName(t.name, args.name) && (!scope || templateWorkspace(t) === scope));
    if (!matches.length) notFound(`No template of yours named "${args.name}"${scope ? " in that workspace" : ""}`);
    const workspaces = new Set(matches.map(templateWorkspace));
    if (workspaces.size > 1) throw new Error(`"${args.name}" names templates of yours in ${workspaces.size} workspaces; pass --team <name|personal> to say which`);
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
