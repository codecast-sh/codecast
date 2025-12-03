import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const updateSyncCursor = mutation({
  args: {
    user_id: v.id("users"),
    file_path_hash: v.string(),
    last_position: v.number(),
  },
  handler: async (ctx, args) => {
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

export const getSyncCursor = query({
  args: {
    user_id: v.id("users"),
    file_path_hash: v.string(),
  },
  handler: async (ctx, args) => {
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
