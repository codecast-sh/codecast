import { internalMutation } from "./functions";
import { v } from "convex/values";
import { maybeRecordUserSend } from "./lib/userSend";

// One-shot backfill for user_send_daily: counts one user's human-typed sends
// over the trailing week so the Sends chart isn't empty on ship day. Live
// counting (messages.ts insert paths) covers everything from deploy time on —
// pass `before` = the deploy timestamp so the two never overlap. Run once per
// user from the dashboard/CLI; safe to skip entirely (history just starts at
// the deploy instead).
export const backfillUserSendsWeek = internalMutation({
  args: {
    user_id: v.id("users"),
    before: v.number(),
  },
  handler: async (ctx, args) => {
    const cutoff = args.before - 7 * 24 * 3600000;
    let counted = 0;
    const convos = ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q: any) =>
        q.eq("user_id", args.user_id).gte("updated_at", cutoff)
      );
    for await (const c of convos) {
      if ((c as any).parent_conversation_id) continue;
      const userMsgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q: any) =>
          q.eq("conversation_id", c._id).eq("role", "user").gte("timestamp", cutoff)
        )
        .take(500);
      for (const m of userMsgs) {
        if (m.timestamp >= args.before) continue;
        const recorded = await maybeRecordUserSend(ctx, c, {
          role: m.role,
          content: m.content,
          tool_results: m.tool_results,
          from_user_id: m.from_user_id,
        }, m.timestamp);
        if (recorded) counted++;
      }
    }
    return { counted };
  },
});

// Reset the counters (e.g. before re-running the backfill after an
// attribution fix). The table is tiny — one row per user/team/active day.
export const wipeSendCounters = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    for await (const row of ctx.db.query("user_send_daily")) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted };
  },
});
