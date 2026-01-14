import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Doc, Id } from "./_generated/dataModel";

export const createFromCLI = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
    message_index: v.number(),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let conversation: Doc<"conversations"> | null = null;

    try {
      conversation = await ctx.db.get(args.session_id as Id<"conversations">);
    } catch {
      // ID format invalid, try other lookups
    }

    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
        .first();
    }

    if (!conversation) {
      const userConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .order("desc")
        .take(200);
      conversation = userConvs.find((c) => c._id.toString().startsWith(args.session_id)) ?? null;
    }

    if (!conversation) {
      return { error: "Conversation not found" };
    }

    if (conversation.user_id.toString() !== result.userId.toString()) {
      return { error: "Can only bookmark messages in your own conversations" };
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .collect();

    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const message = sortedMessages[args.message_index - 1];

    if (!message) {
      return { error: `Message ${args.message_index} not found (conversation has ${sortedMessages.length} messages)` };
    }

    if (args.name) {
      const existing = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_name", (q) => q.eq("user_id", result.userId).eq("name", args.name!))
        .first();
      if (existing) {
        return { error: `Bookmark named "${args.name}" already exists` };
      }
    }

    const bookmark = await ctx.db.insert("bookmarks", {
      user_id: result.userId,
      conversation_id: conversation._id,
      message_id: message._id,
      name: args.name,
      note: args.note,
      created_at: Date.now(),
    });

    const shareToken = conversation.share_token || conversation.session_id;
    const bookmarkUrl = `https://codecast.sh/share/${shareToken}#msg-${args.message_index}`;

    return {
      bookmark_id: bookmark,
      name: args.name,
      conversation_id: conversation._id,
      session_id: conversation.session_id,
      message_index: args.message_index,
      url: bookmarkUrl,
    };
  },
});

export const listFromCLI = mutation({
  args: {
    api_token: v.string(),
    project_path: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 20;

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .order("desc")
      .take(limit);

    const enrichedResults: Array<{
      id: Id<"bookmarks">;
      name: string | undefined;
      note: string | undefined;
      session_id: string | undefined;
      conversation_title: string;
      message_index: number;
      message_preview: string;
      message_role: string;
      project_path: string | undefined;
      url: string;
      created_at: string;
    }> = [];

    for (const bookmark of bookmarks) {
      const conversation = await ctx.db.get(bookmark.conversation_id);
      const message = await ctx.db.get(bookmark.message_id);
      if (!conversation || !message) continue;

      if (args.project_path && conversation.project_path !== args.project_path) {
        continue;
      }

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
        .collect();
      const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
      const messageIndex = sortedMessages.findIndex((m) => m._id.toString() === message._id.toString()) + 1;

      const shareToken = conversation.share_token || conversation.session_id;

      enrichedResults.push({
        id: bookmark._id,
        name: bookmark.name,
        note: bookmark.note,
        session_id: conversation.session_id?.slice(0, 7),
        conversation_title: conversation.title || `Session ${conversation.session_id?.slice(0, 8)}`,
        message_index: messageIndex,
        message_preview: message.content?.slice(0, 100) || "",
        message_role: message.role,
        project_path: conversation.project_path,
        url: `https://codecast.sh/share/${shareToken}#msg-${messageIndex}`,
        created_at: new Date(bookmark.created_at).toISOString(),
      });
    }

    return { bookmarks: enrichedResults, count: enrichedResults.length };
  },
});

export const deleteFromCLI = mutation({
  args: {
    api_token: v.string(),
    name: v.optional(v.string()),
    bookmark_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let bookmark: Doc<"bookmarks"> | null = null;
    if (args.name) {
      bookmark = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_name", (q) => q.eq("user_id", result.userId).eq("name", args.name!))
        .first();
    } else if (args.bookmark_id) {
      bookmark = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .filter((q) => q.eq(q.field("_id"), args.bookmark_id as any))
        .first();
    }

    if (!bookmark) {
      return { error: "Bookmark not found" };
    }

    await ctx.db.delete(bookmark._id);
    return { success: true };
  },
});

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
