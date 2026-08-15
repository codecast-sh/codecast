import { v } from "convex/values";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessPlan, requireAccessiblePlan } from "./lib/access";
import { Id } from "./_generated/dataModel";

// Resolve a plan by its (enumerable) short_id and confirm the caller may reach
// it. Returns the plan id to link, or throws when the short_id names a plan the
// caller cannot access — the short_id alone is never proof of access.
export async function accessiblePlanIdForShortId(
  ctx: any,
  userId: Id<"users">,
  shortId: string | undefined,
): Promise<Id<"plans"> | undefined> {
  if (!shortId) return undefined;
  const plan = await ctx.db
    .query("plans")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", shortId))
    .first();
  if (!plan) return undefined;
  if (!(await canAccessPlan(ctx, userId, plan))) throw new Error("Plan not found");
  return plan._id;
}

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

    const plan_id = await accessiblePlanIdForShortId(ctx, auth.userId, args.plan_short_id);

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
    // Enumerable key: prove plan access before returning its event stream.
    await accessiblePlanIdForShortId(ctx, auth.userId, args.plan_short_id);

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
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    // requireAccessiblePlan throws "Plan not found" for a plan the caller
    // cannot reach — same as every other web plan read.
    await requireAccessiblePlan(ctx, userId, args.plan_id);

    const events = await ctx.db
      .query("orchestration_events")
      .withIndex("by_plan_id", (q) => q.eq("plan_id", args.plan_id))
      .order("desc")
      .take(args.limit || 100);

    return events.reverse();
  },
});
