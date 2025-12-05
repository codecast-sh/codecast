import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

function generateShareToken(): string {
  return crypto.randomUUID();
}

function formatSlugAsTitle(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const createConversation = mutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor")
    ),
    session_id: v.string(),
    project_hash: v.optional(v.string()),
    slug: v.optional(v.string()),
    started_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (authUserId && authUserId.toString() !== args.user_id.toString()) {
      throw new Error("Unauthorized: can only create conversations for yourself");
    }
    if (!authUserId) {
      const user = await ctx.db.get(args.user_id);
      if (!user) {
        throw new Error("Unauthorized: user not found");
      }
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), args.user_id))
      .first();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    const startedAt = args.started_at ?? now;
    const conversationId = await ctx.db.insert("conversations", {
      user_id: args.user_id,
      team_id: args.team_id,
      agent_type: args.agent_type,
      session_id: args.session_id,
      slug: args.slug,
      project_hash: args.project_hash,
      started_at: startedAt,
      updated_at: startedAt,
      message_count: 0,
      is_private: false,
      status: "active",
    });
    return conversationId;
  },
});

export const getConversations = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId || authUserId.toString() !== args.user_id.toString()) {
      return [];
    }
    const user = await ctx.db.get(args.user_id);
    if (!user) {
      return [];
    }
    const allConversations = await ctx.db.query("conversations").collect();
    const filtered = allConversations.filter((c) => {
      const isOwn = c.user_id.toString() === args.user_id.toString();
      if (isOwn) return true;
      if (c.is_private) return false;
      if (user.team_id && c.team_id?.toString() === user.team_id.toString()) {
        return true;
      }
      return false;
    });
    return filtered.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const getConversation = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (conversation.is_private) {
        return null;
      }
      const authUser = await ctx.db.get(authUserId);
      if (
        !authUser ||
        !authUser.team_id ||
        authUser.team_id.toString() !== conversation.team_id?.toString()
      ) {
        return null;
      }
    }
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .collect();
    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const user = await ctx.db.get(conversation.user_id);
    return {
      ...conversation,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
    };
  },
});

export const listConversations = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return [];
    }

    const limit = args.limit ?? 100;

    let conversations;
    if (args.filter === "my") {
      conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc")
        .take(limit);
    } else {
      const allConversations = await ctx.db
        .query("conversations")
        .order("desc")
        .take(limit * 2);
      conversations = allConversations.filter((c) => {
        const isOwn = c.user_id.toString() === userId.toString();
        if (isOwn) return true;
        if (c.is_private) return false;
        if (user.team_id && c.team_id?.toString() === user.team_id.toString()) {
          return true;
        }
        return false;
      }).slice(0, limit);
    }

    const conversationsWithUsers = await Promise.all(
      conversations.map(async (c) => {
        const conversationUser = await ctx.db.get(c.user_id);

        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("asc")
          .take(5);

        let firstMessage = "";
        let preview = "";
        for (const msg of messages) {
          if (msg.content && msg.content.trim()) {
            if (!firstMessage) {
              firstMessage = msg.content.slice(0, 60);
              if (msg.content.length > 60) firstMessage += "...";
            }
            if (!preview) {
              preview = msg.content.slice(0, 100);
              if (msg.content.length > 100) preview += "...";
            }
            if (firstMessage && preview) break;
          }
        }

        const title = c.slug
          ? formatSlugAsTitle(c.slug)
          : c.title || firstMessage || `Session ${c.session_id.slice(0, 8)}`;

        return {
          _id: c._id,
          title,
          preview,
          agent_type: c.agent_type,
          started_at: c.started_at,
          updated_at: c.updated_at,
          message_count: c.message_count,
          status: c.status,
          author_name: conversationUser?.name || "Unknown",
          is_own: c.user_id.toString() === userId.toString(),
        };
      })
    );

    return conversationsWithUsers.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const generateShareLink = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only share your own conversations");
    }
    if (conversation.is_private) {
      throw new Error("Cannot share private conversations");
    }
    if (conversation.share_token) {
      return conversation.share_token;
    }
    const shareToken = generateShareToken();
    await ctx.db.patch(args.conversation_id, {
      share_token: shareToken,
    });
    return shareToken;
  },
});

export const getSharedConversation = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) {
      return null;
    }

    const conversation = conversations[0];

    if (conversation.is_private) {
      return null;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversation._id)
      )
      .collect();

    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const user = await ctx.db.get(conversation.user_id);

    return {
      ...conversation,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
    };
  },
});

export const searchConversations = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return [];
    }

    const searchTerm = args.query.toLowerCase().trim();
    if (!searchTerm || searchTerm.length < 2) {
      return [];
    }

    const limit = args.limit ?? 20;

    const allConversations = await ctx.db
      .query("conversations")
      .order("desc")
      .take(200);

    const accessibleConversations = allConversations.filter((c) => {
      const isOwn = c.user_id.toString() === userId.toString();
      if (isOwn) return true;
      if (c.is_private) return false;
      if (user.team_id && c.team_id?.toString() === user.team_id.toString()) {
        return true;
      }
      return false;
    });

    const results: Array<{
      conversationId: string;
      title: string;
      matches: Array<{
        messageId: string;
        content: string;
        role: string;
        timestamp: number;
      }>;
      updatedAt: number;
      authorName: string;
      isOwn: boolean;
    }> = [];

    for (const conv of accessibleConversations) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", conv._id)
        )
        .collect();

      const matchingMessages = messages.filter(
        (m) => m.content && m.content.toLowerCase().includes(searchTerm)
      );

      if (matchingMessages.length > 0) {
        const conversationUser = await ctx.db.get(conv.user_id);
        const title = conv.slug
          ? formatSlugAsTitle(conv.slug)
          : conv.title || `Session ${conv.session_id.slice(0, 8)}`;

        results.push({
          conversationId: conv._id,
          title,
          matches: matchingMessages.slice(0, 3).map((m) => ({
            messageId: m._id,
            content: m.content || "",
            role: m.role,
            timestamp: m.timestamp,
          })),
          updatedAt: conv.updated_at,
          authorName: conversationUser?.name || "Unknown",
          isOwn: conv.user_id.toString() === userId.toString(),
        });

        if (results.length >= limit) break;
      }
    }

    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const updateSlug = mutation({
  args: {
    conversation_id: v.id("conversations"),
    slug: v.string(),
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
      throw new Error("Unauthorized: can only update your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      slug: args.slug,
    });
  },
});
