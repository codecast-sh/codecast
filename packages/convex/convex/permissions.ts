import { mutation, query } from "./functions";
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

// Window during which an identical pending prompt is treated as a duplicate.
// Two detection paths (transcript-scan + PreToolUse hook) can fire for the same
// tool call within milliseconds of each other; this collapses them into one row.
const DUPLICATE_WINDOW_MS = 10_000;

export const createPermissionRequest = mutation({
  args: {
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    tool_name: v.string(),
    arguments_preview: v.string(),
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
      throw new Error("Unauthorized: can only create permissions for your own conversations");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q: any) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "pending")
      )
      .collect();

    const duplicate = existing.find(
      (p) =>
        p.session_id === args.session_id &&
        p.tool_name === args.tool_name &&
        p.arguments_preview === args.arguments_preview &&
        now - p.created_at < DUPLICATE_WINDOW_MS
    );
    if (duplicate) {
      return duplicate._id;
    }

    const permissionId = await ctx.db.insert("pending_permissions", {
      conversation_id: args.conversation_id,
      session_id: args.session_id,
      tool_name: args.tool_name,
      arguments_preview: args.arguments_preview,
      status: "pending",
      created_at: now,
    });

    return permissionId;
  },
});

export const cancelPermissionRequest = mutation({
  args: {
    permission_id: v.id("pending_permissions"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const permission = await ctx.db.get(args.permission_id);
    if (!permission) return false;
    if (permission.status !== "pending") return false;

    const conversation = await ctx.db.get(permission.conversation_id);
    if (!conversation || conversation.user_id.toString() !== authUserId.toString()) {
      return false;
    }

    await ctx.db.patch(args.permission_id, {
      status: "cancelled",
      resolved_at: Date.now(),
    });
    return true;
  },
});

export const updatePermissionStatus = mutation({
  args: {
    permission_id: v.id("pending_permissions"),
    status: v.union(v.literal("approved"), v.literal("denied")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const permission = await ctx.db.get(args.permission_id);
    if (!permission) {
      throw new Error("Permission not found");
    }

    const conversation = await ctx.db.get(permission.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only manage permissions for your own conversations");
    }

    if (permission.status !== "pending") {
      if (permission.status === args.status) {
        return args.permission_id;
      }
      throw new Error("Permission already resolved");
    }

    await ctx.db.patch(args.permission_id, {
      status: args.status,
      resolved_at: Date.now(),
      resolved_by: userId,
    });

    return args.permission_id;
  },
});

export const cancelPendingPermissions = mutation({
  args: {
    session_id: v.string(),
    // Only cancel records created at or before this timestamp. Guards against
    // a race where the daemon triggers cancellation on transition out of
    // permission_blocked, but Claude Code emits a fresh permission_prompt for
    // the next tool while the cancel is in flight. Without this guard, the
    // cancel mutation could land after the new record is inserted and
    // erroneously cancel it.
    created_before: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const cutoff = args.created_before ?? Date.now();
    const pending = await ctx.db
      .query("pending_permissions")
      .withIndex("by_session", (q) => q.eq("session_id", args.session_id))
      .filter((q) =>
        q.and(
          q.eq(q.field("status"), "pending"),
          q.lte(q.field("created_at"), cutoff)
        )
      )
      .collect();

    let cancelled = 0;
    for (const p of pending) {
      const conv = await ctx.db.get(p.conversation_id);
      if (!conv || conv.user_id.toString() !== authUserId.toString()) continue;
      await ctx.db.patch(p._id, {
        status: "cancelled",
        resolved_at: Date.now(),
      });
      cancelled++;
    }
    return cancelled;
  },
});

export const getPendingPermissions = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return [];
    }

    if (conversation.user_id.toString() !== userId.toString()) {
      return [];
    }

    // Safety net: hide pending rows older than 2 hours. The daemon's local
    // handler cancels rows on its own timeout (~1h), but if the daemon was
    // killed mid-prompt or the cancel mutation failed, the row would otherwise
    // haunt the UI forever. The local timeout is the source of truth; this is
    // just defense in depth.
    const STALE_PENDING_MS = 2 * 60 * 60 * 1000;
    const cutoff = Date.now() - STALE_PENDING_MS;

    const permissions = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "pending")
      )
      .collect();

    return permissions
      .filter((p) => p.created_at > cutoff)
      .sort((a, b) => a.created_at - b.created_at);
  },
});

export const getPermissionDecision = query({
  args: {
    session_id: v.string(),
    permission_id: v.optional(v.id("pending_permissions")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return null;
    }

    if (args.permission_id) {
      const permission = await ctx.db.get(args.permission_id);
      if (!permission || permission.status === "pending") {
        return null;
      }
      const conversation = await ctx.db.get(permission.conversation_id);
      if (!conversation || conversation.user_id.toString() !== authUserId.toString()) {
        return null;
      }
      return {
        _id: permission._id,
        status: permission.status,
        resolved_at: permission.resolved_at,
        tool_name: permission.tool_name,
      };
    }

    const permissions = await ctx.db
      .query("pending_permissions")
      .withIndex("by_session", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.neq(q.field("status"), "pending"))
      .collect();

    if (permissions.length === 0) {
      return null;
    }

    const latest = permissions.sort((a, b) => (b.resolved_at || 0) - (a.resolved_at || 0))[0];

    const conversation = await ctx.db.get(latest.conversation_id);
    if (!conversation) {
      return null;
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      return null;
    }

    return {
      _id: latest._id,
      status: latest.status,
      resolved_at: latest.resolved_at,
      tool_name: latest.tool_name,
    };
  },
});

export const getAllRespondedPermissions = query({
  args: {
    user_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return [];
    }

    if (authUserId.toString() !== args.user_id) {
      return [];
    }

    // Only return recently resolved permissions (last 5 minutes).
    // Older ones are stale — the daemon session has already moved on.
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const permissions = await ctx.db
      .query("pending_permissions")
      .filter((q) =>
        q.and(
          q.neq(q.field("status"), "pending"),
          q.gte(q.field("resolved_at"), fiveMinutesAgo)
        )
      )
      .collect();

    const userPermissions = [];
    for (const permission of permissions) {
      const conversation = await ctx.db.get(permission.conversation_id);
      if (conversation && conversation.user_id.toString() === authUserId.toString()) {
        userPermissions.push({
          _id: permission._id,
          session_id: permission.session_id,
          status: permission.status,
          resolved_at: permission.resolved_at,
          tool_name: permission.tool_name,
        });
      }
    }

    return userPermissions;
  },
});
