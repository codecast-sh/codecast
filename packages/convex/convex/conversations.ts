import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

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
    parent_message_uuid: v.optional(v.string()),
    git_commit_hash: v.optional(v.string()),
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
      is_private: true,
      status: "active",
      parent_message_uuid: args.parent_message_uuid,
      git_commit_hash: args.git_commit_hash,
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

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.slug
      ? formatSlugAsTitle(conversation.slug)
      : conversation.title || firstUserMessage || `Session ${conversation.session_id.slice(0, 8)}`;

    let parentConversationId: string | null = null;
    if (conversation.parent_message_uuid) {
      console.log("Looking for parent with message_uuid:", conversation.parent_message_uuid);
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      console.log("Found parent message:", parentMsg?._id, "in conversation:", parentMsg?.conversation_id);
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const messageUuids = sortedMessages
      .filter((m) => m.message_uuid)
      .map((m) => m.message_uuid!);

    const childConversations: Array<{ _id: string; title: string }> = [];
    if (messageUuids.length > 0) {
      const allConversations = await ctx.db.query("conversations").collect();
      for (const conv of allConversations) {
        if (conv.parent_message_uuid && messageUuids.includes(conv.parent_message_uuid)) {
          const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
          childConversations.push({ _id: conv._id, title: childTitle });
        }
      }
    }

    const childConversationMap: Record<string, string> = {};
    for (const child of childConversations) {
      const childConv = await ctx.db.get(child._id as Id<"conversations">);
      if (childConv && "parent_message_uuid" in childConv && childConv.parent_message_uuid) {
        childConversationMap[childConv.parent_message_uuid] = child._id;
      }
    }

    return {
      ...conversation,
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      parent_conversation_id: parentConversationId,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
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

    const limit = args.limit ?? 400;

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
          .take(50);

        let toolCallCount = 0;
        const toolNames: string[] = [];
        const subagentTypes: string[] = [];
        let aiMessageCount = 0;
        const messageAlternates: Array<{ role: "user" | "assistant"; content: string }> = [];

        for (const msg of messages) {
          if (msg.tool_calls) {
            toolCallCount += msg.tool_calls.length;
            for (const tc of msg.tool_calls) {
              if (toolNames.length < 5 && !toolNames.includes(tc.name)) {
                toolNames.push(tc.name);
              }
              if (tc.name === "Task" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.subagent_type && !subagentTypes.includes(input.subagent_type)) {
                    subagentTypes.push(input.subagent_type);
                  }
                } catch {}
              }
            }
          }
          if (msg.role === "user") {
            const text = msg.content?.trim();
            if (text) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "user", content: truncated });
            }
          }
          if (msg.role === "assistant") {
            aiMessageCount++;
            let text = msg.content?.trim();
            if (!text && msg.thinking) {
              text = msg.thinking.trim();
            }
            if (!text && msg.tool_calls && msg.tool_calls.length > 0) {
              const toolNames = msg.tool_calls.map(tc => tc.name).join(", ");
              text = `[Using: ${toolNames}]`;
            }
            if (text) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "assistant", content: truncated });
            }
          }
        }

        console.log('messageAlternates', messageAlternates);
        const firstUserMessage = messageAlternates.find(m => m.role === "user")?.content || "";
        const firstAssistantMessage = messageAlternates.find(m => m.role === "assistant")?.content || "";

        const title = c.title || firstUserMessage || `Session ${c.session_id.slice(0, 8)}`;
        const durationMs = c.updated_at - c.started_at;
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        const isActive = c.status === "active" && c.updated_at > fiveMinutesAgo;

        let parentConversationId: string | null = null;
        if (c.parent_message_uuid) {
          const parentMsg = await ctx.db
            .query("messages")
            .withIndex("by_message_uuid", (q) => q.eq("message_uuid", c.parent_message_uuid))
            .first();
          if (parentMsg) {
            parentConversationId = parentMsg.conversation_id;
          }
        }

        return {
          _id: c._id,
          title,
          first_user_message: firstUserMessage,
          first_assistant_message: firstAssistantMessage,
          message_alternates: messageAlternates,
          tool_names: toolNames,
          subagent_types: subagentTypes,
          agent_type: c.agent_type,
          model: c.model || null,
          slug: c.slug || null,
          started_at: c.started_at,
          updated_at: c.updated_at,
          duration_ms: durationMs,
          message_count: c.message_count,
          ai_message_count: aiMessageCount,
          tool_call_count: toolCallCount,
          is_active: isActive,
          author_name: conversationUser?.name || conversationUser?.email?.split("@")[0] || "Unknown",
          is_own: c.user_id.toString() === userId.toString(),
          parent_conversation_id: parentConversationId,
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

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.slug
      ? formatSlugAsTitle(conversation.slug)
      : conversation.title || firstUserMessage || `Session ${conversation.session_id.slice(0, 8)}`;

    return {
      ...conversation,
      title,
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
      .take(50);

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
        .take(30);

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
          matches: matchingMessages.slice(0, 3).map((m) => {
            const content = m.content || "";
            const idx = content.toLowerCase().indexOf(searchTerm);
            const start = Math.max(0, idx - 100);
            const end = Math.min(content.length, idx + searchTerm.length + 150);
            let snippet = content.slice(start, end);
            if (start > 0) snippet = "..." + snippet;
            if (end < content.length) snippet = snippet + "...";
            return {
              messageId: m._id,
              content: snippet,
              role: m.role,
              timestamp: m.timestamp,
            };
          }),
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

export const setPrivacy = mutation({
  args: {
    conversation_id: v.id("conversations"),
    is_private: v.boolean(),
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
      throw new Error("Unauthorized: can only change privacy of your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      is_private: args.is_private,
    });
  },
});
