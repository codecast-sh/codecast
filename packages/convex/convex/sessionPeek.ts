// The last few things said in a session, for the hover card's small window
// onto its transcript. Only text a person or the agent wrote: tool calls,
// tool results and encrypted rows drop here; machine framing inside user
// rows (reminders, notifications, slash expansions) is the client's
// classifyFeedMessage to judge. A working agent's newest rows are its own
// notes, so the newest typed prompt rides along from its index however far
// back it is: the card shows what was asked next to the latest answer.
// Same access rule as listMessagesTail.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import { checkConversationAccess } from "./privacy";

// How far back to look for readable turns, and how much of each to ship.
// A busy agent writes a run of tool rows between texts; 40 rows covers that
// without reading a long transcript on every new message while the card is open.
const SCAN = 40;
const TEXT_MAX = 600;

export const recentTurns = query({
  args: {
    conversation_id: v.string(),
    limit: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = id ? await ctx.db.get(id) : null;
    if (!conversation) return null;
    const viewer = await getAuthUserId(ctx);
    if ((await checkConversationAccess(ctx, viewer, conversation, args.share_token)) === "denied") return null;

    const limit = Math.min(Math.max(args.limit ?? 4, 1), 8);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversation._id))
      .order("desc")
      .take(SCAN);
    const ask = await ctx.db
      .query("messages")
      .withIndex("by_conversation_nav_prompt", (q) => q.eq("conversation_id", conversation._id).eq("nav_prompt", true))
      .order("desc")
      .first();
    if (ask && !rows.some((m) => m._id === ask._id)) rows.push(ask);
    const turns: Array<{ _id: string; role: "user" | "assistant"; content: string; timestamp: number }> = [];
    for (const m of rows) {
      if (turns.length >= limit && m._id !== ask?._id) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.is_encrypted || m.subtype || m.tool_results?.length) continue;
      const content = m.content?.trim();
      if (!content) continue;
      turns.push({ _id: m._id, role: m.role, content: content.slice(0, TEXT_MAX), timestamp: m.timestamp });
    }
    return turns.reverse();
  },
});
