import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { checkRateLimit, MESSAGE_LIMIT } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { shouldGenerateTitle } from "./titleGeneration";

export const getMessageTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
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

    const message = await ctx.db.get(args.message_id);
    if (!message || message.conversation_id.toString() !== args.conversation_id.toString()) {
      return null;
    }

    return { timestamp: message.timestamp };
  },
});

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
    thinking: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.object({
      id: v.string(),
      name: v.string(),
      input: v.string(),
    }))),
    tool_results: v.optional(v.array(v.object({
      tool_use_id: v.string(),
      content: v.string(),
      is_error: v.optional(v.boolean()),
    }))),
    images: v.optional(v.array(v.object({
      media_type: v.string(),
      data: v.optional(v.string()),
      storage_id: v.optional(v.id("_storage")),
    }))),
    subtype: v.optional(v.string()),
    timestamp: v.optional(v.number()),
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
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only add messages to your own conversations");
    }

    await checkRateLimit(ctx, conversation.user_id, "addMessage", MESSAGE_LIMIT);

    const msgTimestamp = args.timestamp || Date.now();

    if (args.message_uuid) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("message_uuid", args.message_uuid)
        )
        .first();

      if (existing) {
        if (args.images && args.images.length > 0 && (!existing.images || existing.images.length === 0)) {
          await ctx.db.patch(existing._id, { images: args.images });
        }
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      message_uuid: args.message_uuid,
      role: args.role,
      content: args.content,
      thinking: args.thinking,
      tool_calls: args.tool_calls,
      tool_results: args.tool_results,
      images: args.images,
      subtype: args.subtype,
      timestamp: msgTimestamp,
    });
    const newMessageCount = conversation.message_count + 1;
    await ctx.db.patch(args.conversation_id, {
      message_count: newMessageCount,
      updated_at: msgTimestamp,
    });

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }

    if (!conversation.skip_title_generation && shouldGenerateTitle(newMessageCount)) {
      await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
        conversation_id: args.conversation_id,
      });
    }

    return messageId;
  },
});

function generateShareToken(): string {
  return crypto.randomUUID();
}

export const generateMessageShareLink = mutation({
  args: {
    message_id: v.id("messages"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only share messages from your own conversations");
    }

    const existing = await ctx.db
      .query("message_shares")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .first();

    if (existing) {
      if (args.context_before !== undefined || args.context_after !== undefined || args.note !== undefined) {
        await ctx.db.patch(existing._id, {
          context_before: args.context_before,
          context_after: args.context_after,
          note: args.note,
        });
      }
      return existing.share_token;
    }

    const shareToken = generateShareToken();
    await ctx.db.insert("message_shares", {
      share_token: shareToken,
      message_id: args.message_id,
      user_id: authUserId,
      context_before: args.context_before,
      context_after: args.context_after,
      note: args.note,
      created_at: Date.now(),
    });

    return shareToken;
  },
});

export const findMessageByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
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

    const searchLower = args.search_term.toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    for (const msg of messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) {
        return { message_id: msg._id, timestamp: msg.timestamp };
      }
    }

    return null;
  },
});

export const getSharedMessage = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("message_shares")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();

    if (!share) {
      return null;
    }

    const message = await ctx.db.get(share.message_id);
    if (!message) {
      return null;
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    let contextMessages: typeof message[] = [];
    if (share.context_before || share.context_after) {
      const allMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", message.conversation_id)
        )
        .collect();

      const sorted = allMessages.sort((a, b) => a.timestamp - b.timestamp);
      const targetIndex = sorted.findIndex((m) => m._id === message._id);

      if (targetIndex !== -1) {
        const startIdx = Math.max(0, targetIndex - (share.context_before || 0));
        const endIdx = Math.min(sorted.length, targetIndex + (share.context_after || 0) + 1);
        contextMessages = sorted.slice(startIdx, endIdx);
      }
    }

    return {
      message,
      contextMessages: contextMessages.length > 0 ? contextMessages : [message],
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        project_path: conversation.project_path,
        agent_type: conversation.agent_type,
      },
      user: user ? { name: user.name, image: user.image } : null,
      note: share.note,
      sharedAt: share.created_at,
    };
  },
});
