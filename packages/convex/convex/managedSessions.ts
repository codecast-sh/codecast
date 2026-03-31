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

    const now = Date.now();
    const ACTIVE_STATUSES = new Set(["working", "compacting", "thinking", "connected", "starting", "resuming"]);
    const refreshStatus = session.agent_status && ACTIVE_STATUSES.has(session.agent_status);

    await ctx.db.patch(session._id, {
      last_heartbeat: now,
      ...(refreshStatus ? { agent_status_updated_at: now } : {}),
    });

    let dismissed = false;
    if (session.conversation_id) {
      const conv = await ctx.db.get(session.conversation_id);
      if (conv && conv.inbox_dismissed_at && conv.inbox_dismissed_at >= (conv.updated_at || 0) && !conv.is_subagent) {
        dismissed = true;
      }
    }

    return { found: true, dismissed };
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

    const STALE_THRESHOLD = 60 * 1000;
    const now = Date.now();

    if (!session) {
      return { managed: false };
    }

    const isStale = now - session.last_heartbeat > STALE_THRESHOLD;

    // Check if any child sessions (subagents) are still active
    let has_active_children = false;
    if (isStale) {
      const children = await ctx.db
        .query("conversations")
        .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", args.conversation_id))
        .collect();
      for (const child of children) {
        const childSession = await ctx.db
          .query("managed_sessions")
          .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", child._id))
          .first();
        if (childSession && now - childSession.last_heartbeat < STALE_THRESHOLD) {
          has_active_children = true;
          break;
        }
      }
    }

    return {
      managed: !isStale || has_active_children,
      has_active_children,
      session_id: session.session_id,
      pid: session.pid,
      last_heartbeat: session.last_heartbeat,
      tmux_session: session.tmux_session,
      agent_status: session.agent_status,
      agent_status_updated_at: session.agent_status_updated_at,
      permission_mode: session.permission_mode,
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

    const remaining = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", message.conversation_id).eq("status", "pending")
      )
      .first();
    if (!remaining) {
      await ctx.db.patch(message.conversation_id, { has_pending_messages: false });
    }

    return { success: true };
  },
});

export const updateAgentStatus = mutation({
  args: {
    conversation_id: v.id("conversations"),
    agent_status: v.union(v.literal("working"), v.literal("idle"), v.literal("permission_blocked"), v.literal("compacting"), v.literal("thinking"), v.literal("connected"), v.literal("stopped"), v.literal("starting"), v.literal("resuming")),
    client_ts: v.optional(v.number()),
    api_token: v.optional(v.string()),
    permission_mode: v.optional(v.union(v.literal("default"), v.literal("plan"), v.literal("acceptEdits"), v.literal("bypassPermissions"), v.literal("dontAsk"))),
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

    if (!session) return;
    if (session.user_id.toString() !== authUserId.toString()) return;

    const patch: Record<string, any> = {};

    if (args.permission_mode !== undefined) {
      patch.permission_mode = args.permission_mode;
    }

    const tsStale = args.client_ts && session.agent_status_updated_at && args.client_ts < session.agent_status_updated_at;
    if (!tsStale) {
      patch.agent_status = args.agent_status;
      patch.agent_status_updated_at = args.client_ts || Date.now();
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(session._id, patch);
    }
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
