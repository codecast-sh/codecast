import { internalMutation, type MutationCtx } from "./_generated/server";
import { ConvexError } from "convex/values";
import { fail, type PlaygroundErrorData } from "./lib/errors";
import { RATE, RATE_WINDOW_MAX_MS, type RateRule } from "./lib/limits";
import { takeFromWindow } from "./lib/rateLimit";

export type RateName = keyof typeof RATE;

/** Count one hit of `rule` for `subject` (a visitor id, an app id, "all"),
 *  or throw rate_limited without counting it. */
export async function takeRate(ctx: MutationCtx, name: RateName, subject: string): Promise<void> {
  const rule: RateRule = RATE[name];
  const key = `${name}:${subject}`;
  const row = await ctx.db.query("limits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  const decision = takeFromWindow(row, rule, Date.now());
  if (!decision.allowed) {
    fail("rate_limited", "Slow down a little and try again in a moment.", { retry_after_ms: decision.retryAfterMs });
  }
  if (row) await ctx.db.patch(row._id, decision.next);
  else await ctx.db.insert("limits", { key, ...decision.next });
}

/** Count one hit of `rule` for `subject` if its window has room; false
 *  (and nothing counted) when it is full. For rules that change how a call
 *  is served rather than refuse it. */
export async function rateAllows(ctx: MutationCtx, name: RateName, subject: string): Promise<boolean> {
  try {
    await takeRate(ctx, name, subject);
    return true;
  } catch (e) {
    if (e instanceof ConvexError && (e.data as PlaygroundErrorData).code === "rate_limited") return false;
    throw e;
  }
}

const PRUNE_BATCH = 500;

/** Delete counters whose window has lapsed under every rule, so the table
 *  holds recent callers only. Runs hourly (crons.ts). */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const lapsed = await ctx.db
      .query("limits")
      .withIndex("by_window_start", (q) => q.lt("window_start", Date.now() - RATE_WINDOW_MAX_MS))
      .take(PRUNE_BATCH);
    for (const row of lapsed) await ctx.db.delete(row._id);
    return lapsed.length;
  },
});
