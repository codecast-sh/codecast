import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Manual session buckets are personal: every read/write is scoped to the
// authenticated user. Mutations flow through dispatch (SIDE_EFFECTS.createBucket /
// assignSessionToBucket + applyPatches for bucket field edits) — this module is
// read-only.
export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { buckets: [], assignments: [] };

    const buckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    // Assignments for archived buckets still sync — read-time filters decide
    // visibility, matching the delta-cache convention everywhere else.
    const assignments = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    return { buckets, assignments };
  },
});
