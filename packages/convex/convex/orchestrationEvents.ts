import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";

export const emit = mutation({
  args: {
    api_token: v.string(),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.string(),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    let plan_id;
    if (args.plan_short_id) {
      const plan = await ctx.db
        .query("plans")
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_short_id!))
        .first();
      if (plan) plan_id = plan._id;
    }

    return await ctx.db.insert("orchestration_events", {
      user_id: auth.userId,
      plan_id,
      plan_short_id: args.plan_short_id,
      task_short_id: args.task_short_id,
      event_type: args.event_type as any,
      detail: args.detail,
      metadata: args.metadata,
      created_at: Date.now(),
    });
  },
});

export const listByPlan = query({
  args: {
    api_token: v.string(),
    plan_short_id: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const events = await ctx.db
      .query("orchestration_events")
      .withIndex("by_plan_short_id", (q) => q.eq("plan_short_id", args.plan_short_id))
      .order("desc")
      .take(args.limit || 50);

    return events.reverse();
  },
});

export const webListByPlan = query({
  args: {
    plan_id: v.id("plans"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("orchestration_events")
      .withIndex("by_plan_id", (q) => q.eq("plan_id", args.plan_id))
      .order("desc")
      .take(args.limit || 100);

    return events.reverse();
  },
});
