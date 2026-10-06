import type { MutationCtx } from "./_generated/server";
import { fail } from "./lib/errors";
import { RATE, type RateRule } from "./lib/limits";
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
