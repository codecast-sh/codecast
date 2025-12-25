import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

export const toggleBookmark = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only bookmark messages in your own conversations");
    }

    const existing = await ctx.db
      .query("bookmarks")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (existing) {
      await ctx.db.delete(existing._id);
      return false;
    }

    await ctx.db.insert("bookmarks", {
      user_id: authUserId,
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      created_at: Date.now(),
    });

    return true;
  },
});

export const listBookmarks = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();

    const enriched = await Promise.all(
      bookmarks.map(async (bookmark) => {
        const conversation = await ctx.db.get(bookmark.conversation_id);
        const message = await ctx.db.get(bookmark.message_id);
        if (!conversation || !message) return null;

        return {
          _id: bookmark._id,
          conversation_id: bookmark.conversation_id,
          message_id: bookmark.message_id,
          created_at: bookmark.created_at,
          conversation_title: conversation.title || `Session ${conversation.session_id?.slice(0, 8)}`,
          message_preview: message.content?.slice(0, 100) || "",
          message_role: message.role,
          message_timestamp: message.timestamp,
        };
      })
    );

    return enriched.filter((b): b is NonNullable<typeof b> => b !== null);
  },
});

export const isBookmarked = query({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return false;
    }

    const bookmark = await ctx.db
      .query("bookmarks")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return !!bookmark;
  },
});

export const getConversationBookmarks = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_conversation", (q) =>
        q.eq("user_id", authUserId).eq("conversation_id", args.conversation_id)
      )
      .collect();

    return bookmarks.map((b) => b.message_id);
  },
});
