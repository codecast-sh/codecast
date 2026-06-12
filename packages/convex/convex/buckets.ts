import { query, type QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";

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

// Pure label-name → bucket match: exact (case-insensitive) wins, then
// substring; archived buckets are invisible. The error variant lists the
// caller's labels so a typo is self-correcting.
export function matchBucketByName<B extends { name: string; archived_at?: number }>(
  buckets: B[],
  label: string
): B | { error: string } {
  const active = buckets.filter((b) => !b.archived_at);
  const needle = label.trim().toLowerCase();
  const bucket =
    active.find((b) => b.name.toLowerCase() === needle) ??
    active.find((b) => b.name.toLowerCase().includes(needle));
  if (bucket) return bucket;
  const names = [...new Set(active.map((b) => b.name))].sort().join(", ");
  return {
    error: names
      ? `No label matching "${label}". Your labels: ${names}`
      : `No label matching "${label}" — you have no labels yet (create them in the web sessions panel)`,
  };
}

// Resolve a label (bucket) name to the set of conversation ids the user filed
// under it. Labels are per-user, so this is always "my" filing regardless of
// whose conversations the caller goes on to filter. Used by the CLI read
// surface (cast search/feed/sessions --label).
export async function resolveLabelConvIds(
  ctx: QueryCtx,
  userId: Id<"users">,
  label: string
): Promise<{ convIds: Set<string> } | { error: string }> {
  const buckets = await ctx.db
    .query("inbox_buckets")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const matched = matchBucketByName(buckets, label);
  if ("error" in matched) return matched;
  const assignments = await ctx.db
    .query("bucket_assignments")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  return {
    convIds: new Set(
      assignments
        .filter((a) => a.bucket_id === matched._id)
        .map((a) => a.conversation_id.toString())
    ),
  };
}
