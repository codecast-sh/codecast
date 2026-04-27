import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db
      .query("client_state")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();
  },
});

// Drops draft entries for conversations that no longer exist. Older drafts
// would otherwise accumulate forever and blow past Convex's 1024-fields-per-
// object limit, blocking any subsequent client_state patch (e.g. dismiss).
export const pruneDeadDrafts = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const cs = await ctx.db
      .query("client_state")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .first();
    if (!cs) return { drafts: 0, kept: 0, dropped: 0 };
    const drafts = (cs as any).drafts;
    if (!drafts || typeof drafts !== "object") return { drafts: 0, kept: 0, dropped: 0 };

    const ids = Object.keys(drafts);
    const kept: Record<string, any> = {};
    let dropped = 0;
    for (const id of ids) {
      // Convex ids are 32 chars; anything shorter is a stub that never made it.
      if (!/^[a-z0-9]{32}$/.test(id)) { dropped++; continue; }
      const conv = await ctx.db.get(id as any);
      if (conv) kept[id] = drafts[id];
      else dropped++;
    }
    await ctx.db.patch(cs._id, { drafts: kept, updated_at: Date.now() });
    return { drafts: ids.length, kept: Object.keys(kept).length, dropped };
  },
});
