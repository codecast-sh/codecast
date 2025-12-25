import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const storeWebhookEvent = mutation({
  args: {
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_delivery_id", (q) => q.eq("delivery_id", args.delivery_id))
      .first();

    if (existing) {
      return { success: true, duplicate: true };
    }

    await ctx.db.insert("github_webhook_events", {
      delivery_id: args.delivery_id,
      event_type: args.event_type,
      action: args.action,
      payload: args.payload,
      processed: false,
      created_at: Date.now(),
    });

    return { success: true, duplicate: false };
  },
});
