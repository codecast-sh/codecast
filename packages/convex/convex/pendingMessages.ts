import { mutation, query, internalMutation } from "./_generated/server";
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
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
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

    if (args.client_id) {
      const existing = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .filter((q) => q.eq(q.field("client_id"), args.client_id))
        .first();
      if (existing) return existing._id;
    }

    const messageId = await ctx.db.insert("pending_messages", {
      conversation_id: args.conversation_id,
      from_user_id: authUserId,
      content: args.content,
      image_storage_id: args.image_storage_id,
      image_storage_ids: args.image_storage_ids,
      client_id: args.client_id,
      status: "pending" as const,
      created_at: Date.now(),
      retry_count: 0,
    });

    const now = Date.now();
    await ctx.db.patch(args.conversation_id, {
      updated_at: now,
      has_pending_messages: true,
      ...(conversation.status === "completed" ? { status: "active" } : {}),
      ...(conversation.inbox_dismissed_at ? { inbox_dismissed_at: undefined } : {}),
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
      v.literal("failed"),
      v.literal("undeliverable")
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

    if (args.status !== "pending") {
      const remaining = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", message.conversation_id).eq("status", "pending")
        )
        .first();
      if (!remaining) {
        await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
      }
    }

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

export async function resetConversationPendingMessages(
  ctx: { db: any },
  conversationId: Id<"conversations">
) {
  const messages = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .collect();

  let resetCount = 0;
  for (const msg of messages) {
    if (msg.status === "failed" || msg.status === "undeliverable") {
      await ctx.db.patch(msg._id, { status: "pending", retry_count: 0, delivered_at: undefined });
      resetCount++;
    }
  }

  if (resetCount > 0) {
    await ctx.db.patch(conversationId, { has_pending_messages: true });
  }

  return resetCount;
}

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

export const getConversationPendingMessage = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) return null;

    const msgs = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .filter((q) => q.neq(q.field("status"), "delivered"))
      .collect();

    const owned = msgs.filter((m) => m.from_user_id.toString() === authUserId.toString());
    const msg = owned.find((m) => m.status === "pending")
      ?? owned.find((m) => m.status === "failed")
      ?? owned.find((m) => m.status === "undeliverable")
      ?? null;
    if (!msg) return null;
    return { created_at: msg.created_at, retry_count: msg.retry_count, status: msg.status as string };
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

export const retryStuckMessages = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();

    const pendingMessages = await ctx.db
      .query("pending_messages")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "pending"),
          q.lt(q.field("created_at"), now - 60_000),
          q.gt(q.field("created_at"), now - 10 * 60_000),
          q.lt(q.field("retry_count"), 10)
        )
      )
      .collect();

    for (const msg of pendingMessages) {
      await ctx.db.patch(msg._id, {
        retry_count: msg.retry_count + 1,
      });
    }

    const failedMessages = await ctx.db
      .query("pending_messages")
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "failed"),
          q.gt(q.field("created_at"), now - 10 * 60_000),
          q.lt(q.field("retry_count"), 10)
        )
      )
      .collect();

    for (const msg of failedMessages) {
      await ctx.db.patch(msg._id, {
        status: "pending" as const,
        retry_count: msg.retry_count + 1,
      });
    }

    if (pendingMessages.length > 0 || failedMessages.length > 0) {
      console.log(`retryStuckMessages: bumped ${pendingMessages.length} pending, recovered ${failedMessages.length} failed`);
    }
  },
});
