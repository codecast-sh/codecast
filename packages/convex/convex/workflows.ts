import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";

const nodeV = v.object({
  id: v.string(),
  label: v.string(),
  shape: v.string(),
  type: v.string(),
  prompt: v.optional(v.string()),
  script: v.optional(v.string()),
  reasoning_effort: v.optional(v.string()),
  model: v.optional(v.string()),
  max_visits: v.optional(v.number()),
  max_retries: v.optional(v.number()),
  retry_target: v.optional(v.string()),
  goal_gate: v.optional(v.boolean()),
});

const edgeV = v.object({
  from: v.string(),
  to: v.string(),
  label: v.optional(v.string()),
  condition: v.optional(v.string()),
});

export const upsert = mutation({
  args: {
    api_token: v.string(),
    name: v.string(),
    slug: v.string(),
    goal: v.optional(v.string()),
    source: v.optional(v.string()),
    nodes: v.array(nodeV),
    edges: v.array(edgeV),
    model_stylesheet: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };

    const user = await ctx.db.get(result.userId);
    if (!user) return { error: "User not found" };

    const now = Date.now();
    const existing = await ctx.db
      .query("workflows")
      .withIndex("by_user_slug", (q) => q.eq("user_id", result.userId).eq("slug", args.slug))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        goal: args.goal,
        source: args.source,
        nodes: args.nodes,
        edges: args.edges,
        model_stylesheet: args.model_stylesheet,
        updated_at: now,
      });
      return { id: existing._id, updated: true };
    }

    const id = await ctx.db.insert("workflows", {
      user_id: result.userId,
      team_id: user.team_id,
      name: args.name,
      slug: args.slug,
      goal: args.goal,
      source: args.source,
      nodes: args.nodes,
      edges: args.edges,
      model_stylesheet: args.model_stylesheet,
      created_at: now,
      updated_at: now,
    });
    return { id, updated: false };
  },
});

export const list = mutation({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) return { error: "Unauthorized" };

    const workflows = await ctx.db
      .query("workflows")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .order("desc")
      .take(50);

    return { workflows };
  },
});

export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    return await ctx.db
      .query("workflows")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(50);
  },
});

export const webGet = query({
  args: { id: v.id("workflows") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const w = await ctx.db.get(args.id);
    if (!w || w.user_id !== userId) return null;
    return w;
  },
});
