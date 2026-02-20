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

export const registerManagedSession = mutation({
  args: {
    session_id: v.string(),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const existing = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        pid: args.pid,
        last_heartbeat: now,
        ...(args.tmux_session !== undefined ? { tmux_session: args.tmux_session } : {}),
        ...(args.conversation_id !== undefined ? { conversation_id: args.conversation_id } : {}),
      });
      return existing._id;
    }

    // Remove stale sessions for same conversation
    if (args.conversation_id) {
      const old = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
        .collect();
      for (const o of old) {
        await ctx.db.delete(o._id);
      }
    }

    const id = await ctx.db.insert("managed_sessions", {
      session_id: args.session_id,
      user_id: authUserId,
      pid: args.pid,
      tmux_session: args.tmux_session,
      conversation_id: args.conversation_id,
      started_at: now,
      last_heartbeat: now,
    });

    return id;
  },
});

export const updateSessionConversation = mutation({
  args: {
    session_id: v.string(),
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      throw new Error("Managed session not found");
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    // Remove old sessions linked to this conversation to prevent duplicates
    const oldSessions = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .collect();

    for (const oldSession of oldSessions) {
      if (oldSession._id !== session._id) {
        await ctx.db.delete(oldSession._id);
      }
    }

    await ctx.db.patch(session._id, {
      conversation_id: args.conversation_id,
    });
  },
});

export const updateManagedSessionId = mutation({
  args: {
    old_session_id: v.string(),
    new_session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.old_session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(session._id, {
      session_id: args.new_session_id,
    });

    return { found: true, updated: true };
  },
});

export const heartbeat = mutation({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(session._id, {
      last_heartbeat: Date.now(),
    });

    return { found: true };
  },
});

export const unregisterManagedSession = mutation({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session) {
      return { found: false };
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    await ctx.db.delete(session._id);
    return { found: true };
  },
});

export const isSessionManaged = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .first();

    if (!session) {
      return { managed: false };
    }

    const STALE_THRESHOLD = 60 * 1000;
    const isStale = Date.now() - session.last_heartbeat > STALE_THRESHOLD;

    return {
      managed: !isStale,
      session_id: session.session_id,
      pid: session.pid,
      last_heartbeat: session.last_heartbeat,
      tmux_session: session.tmux_session,
    };
  },
});

export const getPendingMessagesForSession = query({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
      .first();

    if (!session || !session.conversation_id) {
      return [];
    }

    if (session.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized");
    }

    const messages = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", session.conversation_id))
      .filter((q: any) => q.eq(q.field("status"), "pending"))
      .collect();

    return messages;
  },
});

export const markMessageDelivered = mutation({
  args: {
    message_id: v.id("pending_messages"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    await ctx.db.patch(args.message_id, {
      status: "delivered" as const,
      delivered_at: Date.now(),
    });

    return { success: true };
  },
});

export const getConversationBySessionId = query({
  args: {
    claude_session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", args.claude_session_id))
      .first();

    if (!conversation) {
      return null;
    }

    return {
      conversation_id: conversation._id,
      session_id: conversation.session_id,
    };
  },
});
