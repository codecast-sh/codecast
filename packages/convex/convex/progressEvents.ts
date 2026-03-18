import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";

export const append = mutation({
  args: {
    api_token: v.string(),
    plan_short_id: v.string(),
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
        .withIndex("by_short_id", (q) => q.eq("short_id", args.plan_short_id))
        .first();
      if (plan) plan_id = plan._id;
    }

    const existing = await ctx.db
      .query("progress_events")
      .withIndex("by_plan_short_id", (q) => q.eq("plan_short_id", args.plan_short_id))
      .order("desc")
      .first();

    const sequence = existing ? existing.sequence + 1 : 0;

    return await ctx.db.insert("progress_events", {
      user_id: auth.userId,
      plan_id,
      plan_short_id: args.plan_short_id,
      task_short_id: args.task_short_id,
      event_type: args.event_type,
      detail: args.detail,
      metadata: args.metadata,
      sequence,
      created_at: Date.now(),
    });
  },
});

export const replay = query({
  args: {
    api_token: v.string(),
    plan_short_id: v.string(),
    from_sequence: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    let q = ctx.db
      .query("progress_events")
      .withIndex("by_plan_short_id", (q) => q.eq("plan_short_id", args.plan_short_id));

    const events = await q.collect();

    const filtered = args.from_sequence !== undefined
      ? events.filter(e => e.sequence >= args.from_sequence!)
      : events;

    return (args.limit ? filtered.slice(0, args.limit) : filtered);
  },
});

export const latest = query({
  args: {
    api_token: v.string(),
    plan_short_id: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const events = await ctx.db
      .query("progress_events")
      .withIndex("by_plan_short_id", (q) => q.eq("plan_short_id", args.plan_short_id))
      .order("desc")
      .take(1);

    if (events.length === 0) return null;

    const all = await ctx.db
      .query("progress_events")
      .withIndex("by_plan_short_id", (q) => q.eq("plan_short_id", args.plan_short_id))
      .collect();

    const byType: Record<string, number> = {};
    for (const e of all) {
      byType[e.event_type] = (byType[e.event_type] || 0) + 1;
    }

    return {
      latest_event: events[0],
      total_events: all.length,
      event_counts: byType,
    };
  },
});
