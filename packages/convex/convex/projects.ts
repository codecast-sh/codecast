import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { createDataContext } from "./data";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    project_path: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const db = await createDataContext(ctx, { userId: auth.userId, project_path: args.project_path });
    const now = Date.now();

    const id = await db.insert("projects", {
      title: args.title,
      description: args.description,
      status: "active",
      project_path: args.project_path,
      target_date: args.target_date,
      labels: args.labels,
    });

    return { id };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let projects;
    if (args.status) {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_user_status", (q) =>
          q.eq("user_id", auth.userId).eq("status", args.status as any)
        )
        .collect();
    } else {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_user_id", (q) => q.eq("user_id", auth.userId))
        .collect();
    }

    // Enrich with task counts
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_project_id", (q) => q.eq("project_id", p._id))
          .collect();
        const total = tasks.length;
        const done = tasks.filter((t) => t.status === "done").length;
        const in_progress = tasks.filter((t) => t.status === "in_progress").length;
        return { ...p, task_counts: { total, done, in_progress } };
      })
    );

    return enriched;
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const project = await ctx.db.get(args.id);
    if (!project || project.user_id !== auth.userId) return null;

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_project_id", (q) => q.eq("project_id", project._id))
      .collect();

    return { ...project, tasks };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const project = await ctx.db.get(args.id);
    if (!project || project.user_id !== auth.userId) throw new Error("Project not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;
    if (args.status) updates.status = args.status;
    if (args.target_date !== undefined) updates.target_date = args.target_date;
    if (args.labels) updates.labels = args.labels;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

// --- Web-facing queries ---

export const webList = query({
  args: {
    status: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let projects;
    if (args.workspace === "team" && args.team_id) {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id!))
        .collect();
      if (args.status) {
        projects = projects.filter(p => p.status === args.status);
      }
    } else if (args.workspace === "personal") {
      projects = await ctx.db
        .query("projects")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      projects = projects.filter(p => !p.team_id);
      if (args.status) {
        projects = projects.filter(p => p.status === args.status);
      }
    } else {
      // Backwards compat: no workspace arg
      if (args.status) {
        projects = await ctx.db
          .query("projects")
          .withIndex("by_user_status", (q) =>
            q.eq("user_id", userId).eq("status", args.status as any)
          )
          .collect();
      } else {
        projects = await ctx.db
          .query("projects")
          .withIndex("by_user_id", (q) => q.eq("user_id", userId))
          .collect();
      }
    }

    const enriched = await Promise.all(
      projects.map(async (p) => {
        const tasks = await ctx.db
          .query("tasks")
          .withIndex("by_project_id", (q) => q.eq("project_id", p._id))
          .collect();
        const total = tasks.length;
        const done = tasks.filter((t) => t.status === "done").length;
        const in_progress = tasks.filter((t) => t.status === "in_progress").length;
        return { ...p, task_counts: { total, done, in_progress } };
      })
    );

    return enriched;
  },
});
