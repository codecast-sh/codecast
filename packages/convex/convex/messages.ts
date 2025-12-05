import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const addMessage = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_uuid: v.optional(v.string()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
    timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (authUserId) {
      if (conversation.user_id.toString() !== authUserId.toString()) {
        throw new Error("Unauthorized: can only add messages to your own conversations");
      }
    } else {
      const user = await ctx.db.get(conversation.user_id);
      if (!user) {
        throw new Error("Unauthorized: conversation owner not found");
      }
    }

    const msgTimestamp = args.timestamp || Date.now();

    if (args.message_uuid) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("message_uuid", args.message_uuid)
        )
        .first();

      if (existing) {
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      message_uuid: args.message_uuid,
      role: args.role,
      content: args.content,
      timestamp: msgTimestamp,
    });
    await ctx.db.patch(args.conversation_id, {
      message_count: conversation.message_count + 1,
      updated_at: msgTimestamp,
    });
    return messageId;
  },
});
