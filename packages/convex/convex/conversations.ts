import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { internal } from "./_generated/api";

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

function parseSearchTerms(query: string): { phrases: string[]; words: string[]; all: string[] } {
  const phrases: string[] = [];
  const words: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (match[1]) {
      phrases.push(match[1].toLowerCase());
    } else if (match[2]) {
      words.push(match[2].toLowerCase());
    }
  }
  return { phrases, words, all: [...phrases, ...words] };
}

function contentMatchesSearch(content: string, terms: { phrases: string[]; words: string[] }): boolean {
  const lowerContent = content.toLowerCase();
  for (const phrase of terms.phrases) {
    if (!lowerContent.includes(phrase)) return false;
  }
  return true;
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
      throw new Error("Authentication failed: invalid token or session");
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

    if (args.team_id && !existing) {
      await ctx.scheduler.runAfter(0, internal.notifications.notifyTeamSessionStart, {
        conversation_id: conversationId,
        user_id: args.user_id,
      });

      await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
        team_id: args.team_id,
        actor_user_id: args.user_id,
        event_type: "session_started" as const,
        title: args.title || (args.slug ? formatSlugAsTitle(args.slug) : "New session"),
        description: args.project_path,
        related_conversation_id: conversationId,
        metadata: {
          git_branch: args.git_branch,
        },
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

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || `Session ${conversation.session_id.slice(0, 8)}`;

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

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || `Session ${conversation.session_id.slice(0, 8)}`;

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

    let forkedFromDetails = null;
    if (conversation.forked_from) {
      const originalConv = await ctx.db.get(conversation.forked_from);
      if (originalConv) {
        const originalUser = await ctx.db.get(originalConv.user_id);
        forkedFromDetails = {
          conversation_id: originalConv._id,
          share_token: originalConv.share_token,
          username: originalUser?.name || originalUser?.email?.split("@")[0] || "Unknown",
        };
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
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
      forked_from_details: forkedFromDetails,
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

    const limit = args.limit ?? 50;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    let conversations;
    if (args.filter === "my") {
      let query = ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc");

      const allResults = await query.take(limit + 1 + (cursorTimestamp ? 100 : 0));

      let filtered = allResults;
      if (cursorTimestamp) {
        filtered = allResults.filter(c => c.updated_at < cursorTimestamp);
      }
      conversations = filtered.slice(0, limit + 1);
    } else {
      const fetchLimit = cursorTimestamp ? 200 : (limit + 1) * 3;
      const allConversations = await ctx.db
        .query("conversations")
        .order("desc")
        .take(fetchLimit);

      let filtered = allConversations.filter((c) => {
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
          .take(5);

        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("desc")
          .take(5);

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
          user_id: c.user_id,
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
          is_favorite: c.is_favorite || false,
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

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || `Session ${conversation.session_id.slice(0, 8)}`;

    return {
      ...conversation,
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
    };
  },
});

export const searchConversations = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    userOnly: v.optional(v.boolean()),
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
    const userOnly = args.userOnly ?? false;
    const terms = parseSearchTerms(searchTerm);
    const searchQuery = terms.all.join(" ");

    // Use full-text search on messages
    const searchResults = await ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => q.search("content", searchQuery))
      .take(200);

    // Filter for exact phrase matches and group by conversation
    const conversationMatches = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") {
        continue;
      }
      if (terms.phrases.length > 0 && !contentMatchesSearch(msg.content || "", terms)) {
        continue;
      }
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
      messageCount: number;
    }> = [];

    for (const [convId, messages] of conversationMatches) {
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

      // Get first user message for title fallback
      let firstUserMessage = "";
      const firstMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(10);
      for (const msg of firstMessages) {
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

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || `Session ${conv.session_id.slice(0, 8)}`;

      results.push({
        conversationId: conv._id,
        title,
        matches: messages.slice(0, 3).map((m) => {
          const content = m.content || "";
          const lowerContent = content.toLowerCase();
          let bestIdx = -1;
          for (const term of terms.all) {
            const idx = lowerContent.indexOf(term);
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
              bestIdx = idx;
            }
          }
          const start = Math.max(0, bestIdx > -1 ? bestIdx - 80 : 0);
          const end = Math.min(content.length, bestIdx > -1 ? bestIdx + 220 : 300);
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
        messageCount: conv.message_count || 0,
      });
    }

    const sorted = results.sort((a, b) => b.updatedAt - a.updatedAt);
    return { results: sorted.slice(0, limit), totalMatches: searchResults.length };
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

export const setPrivacyBySessionId = mutation({
  args: {
    session_id: v.string(),
    is_private: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      throw new Error(`Conversation not found with session_id: ${args.session_id}`);
    }

    await ctx.db.patch(conversation._id, {
      is_private: args.is_private,
    });

    if (args.api_token) {
      await ctx.db.patch(authUserId, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const makeAllPrivate = mutation({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.neq(q.field("is_private"), true))
      .collect();

    let updated = 0;
    for (const conv of conversations) {
      await ctx.db.patch(conv._id, { is_private: true });
      updated++;
    }

    return { updated, total: conversations.length };
  },
});

export const makeAllPrivateAdmin = internalMutation({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .take(batchSize);

    let updated = 0;
    for (const conv of conversations) {
      await ctx.db.patch(conv._id, { is_private: true });
      updated++;
    }

    return { updated, hasMore: conversations.length === batchSize };
  },
});

export const getConversationBySessionId = query({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return conversation ? { _id: conversation._id } : null;
  },
});

export const getSessionLinks = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { error: "Session not found" };
    }

    let shareToken = conversation.share_token;
    if (!shareToken) {
      shareToken = generateShareToken();
      await ctx.db.patch(conversation._id, { share_token: shareToken });
    }

    return {
      conversation_id: conversation._id,
      share_token: shareToken,
    };
  },
});

export const searchForCLI = mutation({
  args: {
    api_token: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    project_path: v.optional(v.string()),
    user_only: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return { error: "Query must be at least 2 characters" };
    }

    const limit = args.limit ?? 10;
    const contextBefore = args.context_before ?? 0;
    const contextAfter = args.context_after ?? 0;
    const projectPath = args.project_path;
    const userOnly = args.user_only ?? false;
    const terms = parseSearchTerms(searchTerm);
    const searchQuery = terms.all.join(" ");

    const searchResults = await ctx.db
      .query("messages")
      .withSearchIndex("search_content", (q) => q.search("content", searchQuery))
      .take(200);

    const conversationMatches = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") continue;
      if (terms.phrases.length > 0 && !contentMatchesSearch(msg.content || "", terms)) {
        continue;
      }
      const convId = msg.conversation_id.toString();
      if (!conversationMatches.has(convId)) {
        conversationMatches.set(convId, []);
      }
      conversationMatches.get(convId)!.push(msg);
    }

    const results: Array<{
      id: string;
      title: string;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      matches: Array<{
        line: number;
        role: string;
        content: string;
        timestamp: string;
      }>;
      context: Array<{
        line: number;
        role: string;
        content: string;
      }>;
    }> = [];

    let totalMatches = 0;

    for (const [convId, messages] of conversationMatches) {
      const conv = await ctx.db.get(messages[0].conversation_id);
      if (!conv) continue;

      const isOwn = conv.user_id.toString() === authUserId.toString();
      if (!isOwn) {
        if (conv.is_private !== false) continue;
        if (!user.team_id || conv.team_id?.toString() !== user.team_id.toString()) {
          continue;
        }
      }

      if (projectPath && conv.project_path !== projectPath) {
        continue;
      }

      const allMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .collect();

      const messageLineMap = new Map<string, number>();
      allMessages.forEach((m, idx) => {
        messageLineMap.set(m._id.toString(), idx + 1);
      });

      let firstUserMessage = "";
      for (const msg of allMessages.slice(0, 10)) {
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

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || `Session ${conv.session_id.slice(0, 8)}`;

      const searchTermLower = searchTerm.toLowerCase();
      const matchedMessages = messages.slice(0, 5);
      totalMatches += matchedMessages.length;

      const contextLines = new Set<number>();
      const matchedLines = new Set<number>();

      const formattedMatches = matchedMessages.map((m) => {
        const line = messageLineMap.get(m._id.toString()) || 0;
        matchedLines.add(line);

        for (let i = Math.max(1, line - contextBefore); i < line; i++) {
          contextLines.add(i);
        }
        for (let i = line + 1; i <= Math.min(allMessages.length, line + contextAfter); i++) {
          contextLines.add(i);
        }

        return {
          line,
          role: m.role,
          content: m.content || "",
          timestamp: new Date(m.timestamp).toISOString(),
          tool_calls_count: m.tool_calls?.length,
          tool_results_count: m.tool_results?.length,
        };
      });

      const contextMessages: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }> = [];
      for (const lineNum of contextLines) {
        if (matchedLines.has(lineNum)) continue;
        const msg = allMessages[lineNum - 1];
        if (msg) {
          const content = msg.content || "";
          contextMessages.push({
            line: lineNum,
            role: msg.role,
            content,
            tool_calls_count: msg.tool_calls?.length,
            tool_results_count: msg.tool_results?.length,
          });
        }
      }

      results.push({
        id: conv._id,
        title,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || allMessages.length,
        matches: formattedMatches.sort((a, b) => a.line - b.line),
        context: contextMessages.sort((a, b) => a.line - b.line),
      });
    }

    results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    return {
      total_matches: totalMatches,
      conversations: results.slice(0, limit),
      search_scope: projectPath || "global",
    };
  },
});

export const readConversationMessages = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    start_line: v.optional(v.number()),
    end_line: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let conv = null;

    try {
      conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
    } catch {
      // ID format invalid, try prefix search
    }

    if (!conv) {
      const userConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .collect();

      conv = userConvs.find((c) => c._id.toString().startsWith(args.conversation_id));

      if (!conv && user.team_id) {
        const teamConvs = await ctx.db
          .query("conversations")
          .withIndex("by_team_id", (q) => q.eq("team_id", user.team_id))
          .filter((q) => q.eq(q.field("is_private"), false))
          .collect();
        conv = teamConvs.find((c) => c._id.toString().startsWith(args.conversation_id));
      }
    }

    if (!conv) {
      return { error: "Conversation not found" };
    }

    const isOwn = conv.user_id.toString() === authUserId.toString();
    if (!isOwn) {
      if (conv.is_private !== false) {
        return { error: "Access denied" };
      }
      if (!user.team_id || conv.team_id?.toString() !== user.team_id.toString()) {
        return { error: "Access denied" };
      }
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .collect();

    let firstUserMessage = "";
    for (const msg of allMessages.slice(0, 10)) {
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

    const title = conv.title
      || firstUserMessage
      || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
      || `Session ${conv.session_id.slice(0, 8)}`;

    const startLine = args.start_line ?? 1;
    const endLine = args.end_line ?? allMessages.length;

    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(allMessages.length, endLine);

    const messages = allMessages.slice(startIdx, endIdx).map((m, idx) => ({
      line: startIdx + idx + 1,
      role: m.role,
      content: m.content || "",
      timestamp: new Date(m.timestamp).toISOString(),
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
    }));

    return {
      conversation: {
        id: conv._id,
        title,
        project_path: conv.project_path || null,
        message_count: allMessages.length,
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
    };
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
      throw new Error("Authentication failed: invalid token or session");
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

export const listPrivateConversations = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid API token required");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.eq(q.field("is_private"), true))
      .collect();

    const result = await Promise.all(
      conversations.map(async (c) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
          .order("asc")
          .take(20);

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

        const title = c.title
          || firstUserMessage
          || (c.slug ? formatSlugAsTitle(c.slug) : null)
          || `Session ${c.session_id.slice(0, 8)}`;

        return {
          conversation_id: c._id,
          session_id: c.session_id,
          title,
          agent_type: c.agent_type,
          started_at: c.started_at,
          updated_at: c.updated_at,
          message_count: c.message_count,
          project_path: c.project_path,
        };
      })
    );

    return result.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const publishToDirectory = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
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
      throw new Error("Unauthorized: can only publish your own conversations");
    }

    if (!conversation.share_token) {
      throw new Error("Conversation must be shared before publishing to directory");
    }

    const existingPublic = await ctx.db
      .query("public_conversations")
      .filter((q) => q.eq(q.field("conversation_id"), args.conversation_id))
      .first();

    if (existingPublic) {
      await ctx.db.patch(existingPublic._id, {
        title: args.title,
        description: args.description,
        tags: args.tags,
      });
      return existingPublic._id;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("asc")
      .take(10);

    let previewText = "";
    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        const text = msg.content.trim();
        if (text) {
          previewText = text.slice(0, 200);
          break;
        }
      }
    }

    if (!previewText) {
      previewText = "No preview available";
    }

    const publicConversationId = await ctx.db.insert("public_conversations", {
      conversation_id: args.conversation_id,
      user_id: conversation.user_id,
      title: args.title,
      description: args.description,
      tags: args.tags,
      preview_text: previewText,
      agent_type: conversation.agent_type,
      message_count: conversation.message_count,
      created_at: Date.now(),
      view_count: 0,
    });

    return publicConversationId;
  },
});

export const listPublicConversations = query({
  args: {
    search: v.optional(v.string()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("popular"))),
    agent_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const sort = args.sort ?? "recent";

    let publicConversations = await ctx.db
      .query("public_conversations")
      .collect();

    if (args.agent_type) {
      publicConversations = publicConversations.filter(
        (pc) => pc.agent_type === args.agent_type
      );
    }

    if (args.search && args.search.trim().length > 0) {
      const searchLower = args.search.toLowerCase();
      publicConversations = publicConversations.filter((pc) => {
        const titleMatch = pc.title.toLowerCase().includes(searchLower);
        const descMatch = pc.description?.toLowerCase().includes(searchLower);
        const previewMatch = pc.preview_text.toLowerCase().includes(searchLower);
        return titleMatch || descMatch || previewMatch;
      });
    }

    if (sort === "popular") {
      publicConversations.sort((a, b) => b.view_count - a.view_count);
    } else {
      publicConversations.sort((a, b) => b.created_at - a.created_at);
    }

    const results = await Promise.all(
      publicConversations.slice(0, limit).map(async (pc) => {
        const user = await ctx.db.get(pc.user_id);
        const conversation = await ctx.db.get(pc.conversation_id);

        return {
          _id: pc._id,
          title: pc.title,
          description: pc.description,
          tags: pc.tags,
          preview_text: pc.preview_text,
          agent_type: pc.agent_type,
          message_count: pc.message_count,
          created_at: pc.created_at,
          view_count: pc.view_count,
          author_name: user?.name || user?.email?.split("@")[0] || "Unknown",
          author_avatar: user?.image || user?.github_avatar_url,
          share_token: conversation?.share_token || null,
        };
      })
    );

    return results;
  },
});

export const forkConversation = mutation({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in to fork conversations");
    }

    const originalConversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (originalConversations.length === 0) {
      throw new Error("Conversation not found");
    }

    const original = originalConversations[0];

    const authUser = await ctx.db.get(authUserId);
    if (!authUser) {
      throw new Error("User not found");
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", original._id))
      .collect();

    const now = Date.now();
    const newConversationId = await ctx.db.insert("conversations", {
      user_id: authUserId,
      team_id: authUser.team_id,
      agent_type: original.agent_type,
      session_id: `forked-${original.session_id}-${crypto.randomUUID()}`,
      slug: original.slug,
      title: original.title,
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: original.model,
      started_at: now,
      updated_at: now,
      message_count: messages.length,
      is_private: true,
      status: "completed",
      forked_from: original._id,
    });

    for (const msg of messages) {
      await ctx.db.insert("messages", {
        conversation_id: newConversationId,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        tool_calls: msg.tool_calls,
        tool_results: msg.tool_results,
        images: msg.images,
        subtype: msg.subtype,
        timestamp: msg.timestamp,
        tokens_used: msg.tokens_used,
        usage: msg.usage,
      });
    }

    const currentForkCount = original.fork_count ?? 0;
    await ctx.db.patch(original._id, {
      fork_count: currentForkCount + 1,
    });

    return newConversationId;
  },
});

export const toggleFavorite = mutation({
  args: {
    conversation_id: v.id("conversations"),
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
      throw new Error("Can only favorite your own conversations");
    }

    const newValue = !conversation.is_favorite;
    await ctx.db.patch(args.conversation_id, {
      is_favorite: newValue,
    });

    return newValue;
  },
});

export const listFavorites = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", authUserId).eq("is_favorite", true)
      )
      .collect();

    return favorites
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((conv) => ({
        _id: conv._id,
        title: conv.title,
        session_id: conv.session_id,
        updated_at: conv.updated_at,
        message_count: conv.message_count,
        agent_type: conv.agent_type,
        is_favorite: conv.is_favorite,
      }));
  },
});

export const getMessageFeed = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { messages: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { messages: [], nextCursor: null };
    }

    const limit = args.limit ?? 30;

    // Get recent conversations (limited to avoid reading too much data)
    let recentConvs;
    if (args.filter === "my") {
      recentConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc")
        .take(50);
    } else {
      if (!user.team_id) {
        return { messages: [], nextCursor: null };
      }
      recentConvs = await ctx.db
        .query("conversations")
        .withIndex("by_team_id", (q) => q.eq("team_id", user.team_id))
        .filter((q) => q.eq(q.field("is_private"), false))
        .order("desc")
        .take(50);
    }

    if (recentConvs.length === 0) {
      return { messages: [], nextCursor: null };
    }

    // Build conversation info cache
    const conversationCache = new Map<string, {
      title: string;
      session_id: string;
      author_name: string;
      is_own: boolean;
    }>();

    for (const conv of recentConvs) {
      const convUser = await ctx.db.get(conv.user_id);
      conversationCache.set(conv._id, {
        title: conv.title || (conv.slug ? formatSlugAsTitle(conv.slug) : `Session ${conv.session_id.slice(0, 8)}`),
        session_id: conv.session_id,
        author_name: convUser?.name || convUser?.email?.split("@")[0] || "Unknown",
        is_own: conv.user_id.toString() === userId.toString(),
      });
    }

    // Collect messages from each conversation
    const allMessages: Array<{
      _id: string;
      conversation_id: string;
      role: string;
      content: string | undefined;
      timestamp: number;
      has_tool_calls: boolean;
      has_tool_results: boolean;
    }> = [];

    for (const conv of recentConvs) {
      let msgQuery = ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => {
          let q2 = q.eq("conversation_id", conv._id);
          if (args.cursor) {
            return q2.lt("timestamp", args.cursor);
          }
          return q2;
        })
        .order("desc");

      const messages = await msgQuery.take(10);

      for (const msg of messages) {
        if (msg.role === "user" || msg.role === "assistant") {
          // Skip messages with no meaningful content
          const hasContent = msg.content && msg.content.trim().length > 10;
          if (!hasContent) continue;

          allMessages.push({
            _id: msg._id,
            conversation_id: msg.conversation_id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            has_tool_calls: (msg.tool_calls && msg.tool_calls.length > 0) || false,
            has_tool_results: (msg.tool_results && msg.tool_results.length > 0) || false,
          });
        }
      }
    }

    // Sort by timestamp descending
    allMessages.sort((a, b) => b.timestamp - a.timestamp);

    const resultMessages = allMessages.slice(0, limit + 1);
    const hasMore = resultMessages.length > limit;
    const finalMessages = hasMore ? resultMessages.slice(0, limit) : resultMessages;

    const messagesWithConversation = finalMessages.map((msg) => {
      const convInfo = conversationCache.get(msg.conversation_id);
      return {
        _id: msg._id,
        conversation_id: msg.conversation_id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        has_tool_calls: msg.has_tool_calls,
        has_tool_results: msg.has_tool_results,
        conversation_title: convInfo?.title || "Unknown",
        conversation_session_id: convInfo?.session_id || "",
        author_name: convInfo?.author_name || "Unknown",
        is_own: convInfo?.is_own ?? false,
      };
    });

    const nextCursor = hasMore ? finalMessages[finalMessages.length - 1].timestamp : null;

    return {
      messages: messagesWithConversation,
      nextCursor,
    };
  },
});
