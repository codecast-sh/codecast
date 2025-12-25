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
    tool_name: v.string(),
    arguments_preview: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only create permissions for your own conversations");
    }

    const permissionId = await ctx.db.insert("pending_permissions", {
      conversation_id: args.conversation_id,
      tool_name: args.tool_name,
      arguments_preview: args.arguments_preview,
      status: "pending" as const,
      created_at: Date.now(),
    });

    return permissionId;
  },
});

export const respondToPermission = mutation({
  args: {
    permission_id: v.id("pending_permissions"),
    decision: v.union(v.literal("approved"), v.literal("denied")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }

    const permission = await ctx.db.get(args.permission_id);
    if (!permission) {
      throw new Error("Permission not found");
    }

    const conversation = await ctx.db.get(permission.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only respond to permissions for your own conversations");
    }

    await ctx.db.patch(args.permission_id, {
      status: args.decision,
      responded_at: Date.now(),
    });

    return { success: true };
  },
});

export const getPendingPermissions = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only get permissions for your own conversations");
    }

    const permissions = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", args.conversation_id).eq("status", "pending")
      )
      .collect();

    return permissions;
  },
});

export const getAllRespondedPermissions = query({
  args: {
    user_id: v.optional(v.id("users")),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid session or API token required");
    }

    const targetUserId = args.user_id || authUserId;

    if (targetUserId.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only get your own permissions");
    }

    const allPermissions = await ctx.db
      .query("pending_permissions")
      .collect();

    const respondedPermissions = [];
    for (const permission of allPermissions) {
      if (permission.status === "pending") continue;

      const conversation = await ctx.db.get(permission.conversation_id);
      if (!conversation) continue;

      if (conversation.user_id.toString() === targetUserId.toString()) {
        respondedPermissions.push(permission);
      }
    }

    return respondedPermissions;
  },
});
