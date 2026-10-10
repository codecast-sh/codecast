// Reads and retention for the session lifecycle trail (lifecycleEvents.ts).
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";

const RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

/** A conversation's lifecycle events, oldest first: `packages/convex/run.sh conversationEvents:list '{"conversation_id":"<full id>"}'`. */
export const list = internalQuery({
  args: { conversation_id: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("conversation_events")
      .withIndex("by_conversation_ts", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(args.limit ?? 100);
    return rows.reverse().map((r) => ({ at: new Date(r.ts).toISOString(), kind: r.kind, changes: r.changes, cause: r.cause, stack: r.stack }));
  },
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("conversation_events")
      .withIndex("by_ts", (q) => q.lt("ts", Date.now() - RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH) await ctx.scheduler.runAfter(1000, (internal as any).conversationEvents.prune, {});
    return old.length;
  },
});
