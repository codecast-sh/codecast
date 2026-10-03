import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { maybeRecordUserSend } from "./lib/userSend";
import { approxMessageBytes } from "./userMessagesFilter";

// Rebuild the typed-send counters (user_send_daily) from the transcripts, for
// the days before live counting under the current rule began. Live counting
// (messages.ts insert paths) owns every message inserted from then on, so the
// rebuild takes only messages created before `before` and the two never
// overlap. `start` picks that moment from the table itself: the creation time
// of the first row the current rule wrote.
//
// One step walks conversations newest first, so the recent days fill in
// first, and reads each one's user-role messages since `after`. Tool-result
// turns are user-role too and can be large, so a step stops at a byte budget
// and schedules the next from where it stopped. When no conversations remain
// it deletes the rows the older rule wrote.
const STEP_BYTES = 4_000_000;
const STEP_CONVERSATIONS = 150;

export const start = internalMutation({
  args: { after: v.number() },
  handler: async (ctx, args) => {
    let before = Date.now();
    for await (const row of ctx.db.query("user_send_daily").order("desc")) {
      if (!row.word_hours) break;
      before = row._creationTime;
    }
    await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { after: args.after, before });
    return { before };
  },
});

export const step = internalMutation({
  args: {
    after: v.number(),
    before: v.number(),
    // Resume point: conversations created before this are still to do...
    conv_before: v.optional(v.number()),
    // ...or this one is half read, up to this message timestamp.
    conv_id: v.optional(v.id("conversations")),
    msg_after: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const range = { after: args.after, before: args.before };
    let bytes = 0;
    let convBefore = args.conv_before ?? Number.MAX_SAFE_INTEGER;
    let resume = args.conv_id ? await ctx.db.get(args.conv_id) : null;
    let msgAfter = args.msg_after ?? args.after - 1;
    for (let n = 0; n < STEP_CONVERSATIONS; n++) {
      const c =
        resume ??
        (await ctx.db
          .query("conversations")
          .withIndex("by_creation_time", (q) => q.lt("_creationTime", convBefore))
          .order("desc")
          .first());
      if (!c) {
        await ctx.scheduler.runAfter(0, internal.sendBackfill.dropStaleRows, {});
        return;
      }
      resume = null;
      if (!c.parent_conversation_id && (c.updated_at ?? c._creationTime) >= args.after) {
        // A fork starts with a copy of its parent's history, which the parent
        // already counts: the fork owns only what came after it was created.
        const from = c.forked_from ? Math.max(msgAfter, c._creationTime - 1) : msgAfter;
        const msgs = ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q.eq("conversation_id", c._id).eq("role", "user").gt("timestamp", from),
          );
        for await (const m of msgs) {
          bytes += approxMessageBytes(m as any);
          if (m._creationTime < args.before) {
            await maybeRecordUserSend(ctx, c, { role: m.role, content: m.content, tool_results: m.tool_results, from_user_id: m.from_user_id }, m.timestamp);
          }
          if (bytes > STEP_BYTES) {
            await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...range, conv_before: convBefore, conv_id: c._id, msg_after: m.timestamp });
            return;
          }
        }
      }
      convBefore = c._creationTime;
      msgAfter = args.after - 1;
    }
    await ctx.scheduler.runAfter(0, internal.sendBackfill.step, { ...range, conv_before: convBefore });
  },
});

// The rows an older rule wrote, superseded once their days are rebuilt.
export const dropStaleRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    for await (const row of ctx.db.query("user_send_daily")) {
      if (row.word_hours) continue;
      await ctx.db.delete(row._id);
      if (++deleted >= 2000) {
        await ctx.scheduler.runAfter(0, internal.sendBackfill.dropStaleRows, {});
        break;
      }
    }
    return { deleted };
  },
});
