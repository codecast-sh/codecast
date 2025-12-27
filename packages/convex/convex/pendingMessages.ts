import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";

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

export const sendMessageToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    content: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only send messages to your own conversations");
    }

    if (conversation.status !== "active") {
      throw new Error("Cannot send message to inactive conversation");
    }

    const messageId = await ctx.db.insert("pending_messages", {
      conversation_id: args.conversation_id,
      from_user_id: authUserId,
      content: args.content,
      status: "pending" as const,
      created_at: Date.now(),
      retry_count: 0,
    });

    return messageId;
  },
});

export const updateMessageStatus = mutation({
  args: {
    message_id: v.id("pending_messages"),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed")
    ),
    delivered_at: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only update your own messages");
    }

    await ctx.db.patch(args.message_id, {
      status: args.status,
      delivered_at: args.delivered_at,
    });

    return { success: true };
  },
});

export const retryMessage = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only retry your own messages");
    }

    await ctx.db.patch(args.message_id, {
      status: "pending" as const,
      retry_count: message.retry_count + 1,
    });

    return { success: true };
  },
});

export const getPendingMessages = query({
  args: {
    user_id: v.optional(v.id("users")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const targetUserId = args.user_id || authUserId;

    if (targetUserId.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only get your own pending messages");
    }

    const messages = await ctx.db
      .query("pending_messages")
      .withIndex("by_user_status", (q) =>
        q.eq("from_user_id", targetUserId).eq("status", "pending")
      )
      .collect();

    return messages;
  },
});

export const getMessageStatus = query({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    if (message.from_user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only check status of your own messages");
    }

    return {
      status: message.status,
      created_at: message.created_at,
      delivered_at: message.delivered_at,
      retry_count: message.retry_count,
    };
  },
});
