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
      throw new Error("Unauthorized: valid session or API token required");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only create permissions for your own conversations");
    }

    const permissionId = await ctx.db.insert("pending_permissions", {
      conversation_id: args.conversation_id,
      session_id: args.session_id,
      tool_name: args.tool_name,
      arguments_preview: args.arguments_preview,
      status: "pending",
      created_at: Date.now(),
    });

    return permissionId;
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

    const permissions = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "pending")
      )
      .collect();

    return permissions.sort((a, b) => a.created_at - b.created_at);
  },
});

export const getPermissionDecision = query({
  args: {
    session_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return null;
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
