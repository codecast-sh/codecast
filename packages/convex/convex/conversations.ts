import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

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
    project_path: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    started_at: v.optional(v.number()),
    parent_message_uuid: v.optional(v.string()),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    git_status: v.optional(v.string()),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    git_root: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }
    if (authUserId.toString() !== args.user_id.toString()) {
      throw new Error("Unauthorized: can only create conversations for yourself");
    }

    await checkRateLimit(ctx, args.user_id, "createConversation");

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
      title: args.title,
      project_hash: args.project_hash,
      project_path: args.project_path,
      started_at: startedAt,
      updated_at: startedAt,
      message_count: 0,
      is_private: true,
      status: "active",
      parent_message_uuid: args.parent_message_uuid,
      git_commit_hash: args.git_commit_hash,
      git_branch: args.git_branch,
      git_remote_url: args.git_remote_url,
      git_status: args.git_status,
      git_diff: args.git_diff,
      git_diff_staged: args.git_diff_staged,
      git_root: args.git_root,
    });

    if (args.api_token) {
      await ctx.db.patch(args.user_id, {
        daemon_last_seen: now,
      });
    }

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
      if (c.is_private !== false) return false;
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
    limit: v.optional(v.number()),
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
      if (conversation.is_private !== false) {
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

    const limit = args.limit ?? 100;
    // Fetch most recent messages (descending), then reverse for display
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

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
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
    };
  },
});

export const getAllMessages = query({
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
      if (conversation.is_private !== false) {
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
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of messages) {
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

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    const childConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
      .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
      .take(100);

    const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
    for (const conv of childConvs) {
      if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
        const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
        childConversations.push({ _id: conv._id, title: childTitle });
        childConversationMap[conv.parent_message_uuid] = conv._id;
      }
    }

    return {
      ...conversation,
      title,
      messages,
      user: user ? { name: user.name, email: user.email } : null,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
    };
  },
});

export const getNewMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.number(),
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
      if (conversation.is_private !== false) {
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
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp)
      )
      .order("asc")
      .collect();

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    if (messages.length > 0) {
      const childConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
        .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
        .take(100);

      const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
      for (const conv of childConvs) {
        if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
          const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
          childConversations.push({ _id: conv._id, title: childTitle });
          childConversationMap[conv.parent_message_uuid] = conv._id;
        }
      }
    }

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      updated_at: conversation.updated_at,
      title: conversation.title,
    };
  },
});

export const getConversationMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.optional(v.number()),
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
      if (conversation.is_private !== false) {
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

    let messages;
    if (args.after_timestamp) {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp!)
        )
        .order("asc")
        .collect();
    } else {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .order("asc")
        .collect();
    }

    const childConversations: Array<{ _id: string; title: string }> = [];
    const childConversationMap: Record<string, string> = {};

    const childConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", conversation.user_id))
      .filter((q) => q.neq(q.field("parent_message_uuid"), undefined))
      .take(100);

    const messageUuids = new Set(messages.filter((m) => m.message_uuid).map((m) => m.message_uuid!));
    for (const conv of childConvs) {
      if (conv.parent_message_uuid && messageUuids.has(conv.parent_message_uuid)) {
        const childTitle = conv.title || `Session ${conv.session_id.slice(0, 8)}`;
        childConversations.push({ _id: conv._id, title: childTitle });
        childConversationMap[conv.parent_message_uuid] = conv._id;
      }
    }

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
    };
  },
});

export const getMoreMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.number(),
    limit: v.optional(v.number()),
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
      if (conversation.is_private !== false) {
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

    const limit = args.limit ?? 100;
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .filter((q) => q.gt(q.field("timestamp"), args.cursor))
      .take(limit + 1);

    const hasMore = allMessages.length > limit;
    const messages = hasMore ? allMessages.slice(0, limit) : allMessages;
    const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  },
});

export const getOlderMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    before_timestamp: v.number(),
    limit: v.optional(v.number()),
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
      if (conversation.is_private !== false) {
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

    const limit = args.limit ?? 100;
    // Fetch messages older than the cursor, in descending order (newest of the older ones first)
    const olderMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .filter((q) => q.lt(q.field("timestamp"), args.before_timestamp))
      .take(limit + 1);

    const hasMore = olderMessages.length > limit;
    const resultMessages = hasMore ? olderMessages.slice(0, limit) : olderMessages;
    // Sort ascending for display (oldest first)
    const messages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      oldest_timestamp: oldestTimestamp,
    };
  },
});

export const listConversations = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { conversations: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { conversations: [], nextCursor: null };
    }

    const limit = args.limit ?? 500;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    let conversations;
    if (args.filter === "my") {
      let query = ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc");

      const allResults = await query.take(limit + 1 + (cursorTimestamp ? 500 : 0));

      let filtered = allResults;
      if (cursorTimestamp) {
        filtered = allResults.filter(c => c.updated_at < cursorTimestamp);
      }
      conversations = filtered.slice(0, limit + 1);
    } else {
      const fetchLimit = cursorTimestamp ? 500 : (limit + 1) * 2;
      const allConversations = await ctx.db
        .query("conversations")
        .order("desc")
        .take(fetchLimit);

      let filtered = allConversations.filter((c) => {
        const isOwn = c.user_id.toString() === userId.toString();
        if (isOwn) return true;
        if (c.is_private !== false) return false;
        if (user.team_id && c.team_id?.toString() === user.team_id.toString()) {
          return true;
        }
        return false;
      });

      if (cursorTimestamp) {
        filtered = filtered.filter(c => c.updated_at < cursorTimestamp);
      }
      conversations = filtered.slice(0, limit + 1);
    }

    const hasMore = conversations.length > limit;
    const resultConversations = hasMore ? conversations.slice(0, limit) : conversations;
    const nextCursor = hasMore ? String(resultConversations[resultConversations.length - 1].updated_at) : null;

    const conversationsWithUsers = await Promise.all(
      resultConversations.map(async (c) => {
        const conversationUser = await ctx.db.get(c.user_id);

        const firstMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("asc")
          .take(20);

        // Also fetch recent messages to get latest todos
        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("desc")
          .take(10);

        // Combine and dedupe
        const messageIds = new Set<string>();
        const messages = [];
        for (const m of firstMessages) {
          if (!messageIds.has(m._id)) {
            messageIds.add(m._id);
            messages.push(m);
          }
        }
        for (const m of recentMessages) {
          if (!messageIds.has(m._id)) {
            messageIds.add(m._id);
            messages.push(m);
          }
        }

        let toolCallCount = 0;
        const toolNames: string[] = [];
        const subagentTypes: string[] = [];
        let aiMessageCount = 0;
        const messageAlternates: Array<{ role: "user" | "assistant"; content: string }> = [];
        let latestTodos: { todos: any[]; timestamp: number } | undefined;

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
              // Extract TodoWrite todos
              if (tc.name === "TodoWrite" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.todos) {
                    if (!latestTodos || msg.timestamp > latestTodos.timestamp) {
                      latestTodos = {
                        todos: input.todos,
                        timestamp: msg.timestamp,
                      };
                    }
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
          subtitle: c.subtitle || null,
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
          latest_todos: latestTodos,
          project_path: c.project_path || null,
          git_root: c.git_root || null,
          git_branch: c.git_branch || null,
          git_remote_url: c.git_remote_url || null,
        };
      })
    );

    return {
      conversations: conversationsWithUsers.sort((a, b) => b.updated_at - a.updated_at),
      nextCursor,
    };
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

    if (conversation.is_private !== false) {
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

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return [];
    }

    const limit = args.limit ?? 20;

    // Use full-text search on messages
    const searchResults = await ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => q.search("content", searchTerm))
      .take(100);

    // Group by conversation and check access
    const conversationMatches = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      const convId = msg.conversation_id.toString();
      if (!conversationMatches.has(convId)) {
        conversationMatches.set(convId, []);
      }
      conversationMatches.get(convId)!.push(msg);
    }

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

    for (const [convId, messages] of conversationMatches) {
      if (results.length >= limit) break;

      const conv = await ctx.db.get(messages[0].conversation_id);
      if (!conv) continue;

      // Check access
      const isOwn = conv.user_id.toString() === userId.toString();
      if (!isOwn) {
        if (conv.is_private !== false) continue;
        if (!user.team_id || conv.team_id?.toString() !== user.team_id.toString()) {
          continue;
        }
      }

      const conversationUser = await ctx.db.get(conv.user_id);
      const title = conv.slug
        ? formatSlugAsTitle(conv.slug)
        : conv.title || `Session ${conv.session_id.slice(0, 8)}`;

      const searchTermLower = searchTerm.toLowerCase();
      results.push({
        conversationId: conv._id,
        title,
        matches: messages.slice(0, 3).map((m) => {
          const content = m.content || "";
          const idx = content.toLowerCase().indexOf(searchTermLower);
          const start = Math.max(0, idx > -1 ? idx - 100 : 0);
          const end = Math.min(content.length, idx > -1 ? idx + searchTerm.length + 150 : 250);
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
        isOwn,
      });
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

export const updateTitle = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    let isTeamMember = false;
    if (!isOwner && conversation.team_id) {
      const authUser = await ctx.db.get(authUserId);
      if (authUser?.team_id && authUser.team_id.toString() === conversation.team_id.toString()) {
        isTeamMember = true;
      }
    }

    if (!isOwner && !isTeamMember) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      title: args.title,
    });

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});
