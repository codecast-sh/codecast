// Daily totals: build spend and fork copy bytes, each counted per UTC day
// under a key. Everything a daily budget reads lives here, so charging a
// build never rewrites the app row that every room and the gallery read.
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";

/** The UTC day a total counts toward. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const TALLY = {
  spend: "spend",
  appSpend: (appId: Id<"apps">) => `spend:app:${appId}`,
  visitorSpend: (visitorId: Id<"visitors">) => `spend:visitor:${visitorId}`,
  copied: "copied",
  visitorCopied: (visitorId: Id<"visitors">) => `copied:visitor:${visitorId}`,
};

function row(ctx: QueryCtx, key: string, day: string) {
  return ctx.db.query("tallies").withIndex("by_key_day", (q) => q.eq("key", key).eq("day", day)).unique();
}

export async function tally(ctx: QueryCtx, key: string, now = Date.now()): Promise<number> {
  return (await row(ctx, key, dayKey(now)))?.value ?? 0;
}

/** Add to today's total under each key (a negative amount gives back). */
export async function addTally(ctx: MutationCtx, keys: string[], amount: number, now = Date.now()): Promise<void> {
  if (amount === 0) return;
  const day = dayKey(now);
  for (const key of keys) {
    const r = await row(ctx, key, day);
    if (r) await ctx.db.patch(r._id, { value: r.value + amount });
    else await ctx.db.insert("tallies", { key, day, value: amount });
  }
}

const PRUNE_BATCH = 500;

/** Delete totals from before yesterday; nothing reads them. Runs hourly. */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("tallies")
      .withIndex("by_day", (q) => q.lt("day", dayKey(Date.now() - 86_400_000)))
      .take(PRUNE_BATCH);
    for (const r of old) await ctx.db.delete(r._id);
    return old.length;
  },
});
