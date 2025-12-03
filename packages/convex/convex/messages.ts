import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const addMessage = mutation({
  args: {
    conversation_id: v.id("conversations"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      role: args.role,
      content: args.content,
      timestamp: now,
    });
    const conversation = await ctx.db.get(args.conversation_id);
    if (conversation) {
      await ctx.db.patch(args.conversation_id, {
        message_count: conversation.message_count + 1,
        updated_at: now,
      });
    }
    return messageId;
  },
});
