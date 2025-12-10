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

export const updateSyncCursor = mutation({
  args: {
    user_id: v.id("users"),
    file_path_hash: v.string(),
    last_position: v.number(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId || authUserId.toString() !== args.user_id.toString()) {
      throw new Error("Unauthorized: valid session or API token required");
    }
    const existing = await ctx.db
      .query("sync_cursors")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .collect();
    const cursor = existing.find(
      (c) => c.file_path_hash === args.file_path_hash
    );
    const now = Date.now();
    if (cursor) {
      await ctx.db.patch(cursor._id, {
        last_position: args.last_position,
        last_synced_at: now,
      });
      return cursor._id;
    }
    const cursorId = await ctx.db.insert("sync_cursors", {
      user_id: args.user_id,
      file_path_hash: args.file_path_hash,
      last_position: args.last_position,
      last_synced_at: now,
    });
    return cursorId;
  },
});

async function getAuthenticatedUserIdReadOnly(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken, false);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

export const getSyncCursor = query({
  args: {
    user_id: v.id("users"),
    file_path_hash: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId || authUserId.toString() !== args.user_id.toString()) {
      return null;
    }
    const cursors = await ctx.db
      .query("sync_cursors")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .collect();
    const cursor = cursors.find(
      (c) => c.file_path_hash === args.file_path_hash
    );
    if (!cursor) {
      return null;
    }
    return cursor.last_position;
  },
});
