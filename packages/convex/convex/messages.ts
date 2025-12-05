import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

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
    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      role: args.role,
      content: args.content,
      timestamp: now,
    });
    await ctx.db.patch(args.conversation_id, {
      message_count: conversation.message_count + 1,
      updated_at: now,
    });
    return messageId;
  },
});
