import { defineTable } from "convex/server";
import { v } from "convex/values";

/** What a regulated team's permanent delete removes. */
export const dataDeletionKindValidator = v.union(
  v.literal("session"),
  v.literal("page"),
  v.literal("call"),
  v.literal("team"),
);

/** One thing the job still has to purge: a conversation's rows, a page, a call, or the whole team from `step` on. */
export const deletionRootValidator = v.object({
  plan: v.union(v.literal("conversation"), v.literal("artifact"), v.literal("call"), v.literal("team")),
  id: v.string(),
  step: v.optional(v.number()),
});

/**
 * Permanent deletes of a regulated team's data (regulatedDeletion.ts): who
 * asked, what, when, and how many rows each table lost. The row is also the
 * job's state: `roots` is what remains, so a pass that fails is picked up by
 * the resume cron from where the last good pass left it. Kept after the team
 * itself is gone, as the record that its data was destroyed.
 */
export const dataDeletionTables = {
  data_deletions: defineTable({
    team_id: v.id("teams"),
    team_name: v.string(),
    actor_user_id: v.id("users"),
    kind: dataDeletionKindValidator,
    target_id: v.string(),
    target_label: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("done")),
    roots: v.array(deletionRootValidator),
    // Rows deleted per table (and storage_files for stored objects).
    counts: v.record(v.string(), v.number()),
    passes: v.number(),
    // Which chain of passes is current; the resume cron bumps it, so a stalled chain that wakes up ends.
    gen: v.number(),
    requested_at: v.number(),
    updated_at: v.number(),
    finished_at: v.optional(v.number()),
  })
    .index("by_team_requested", ["team_id", "requested_at"])
    .index("by_status_updated", ["status", "updated_at"])
    .index("by_target", ["kind", "target_id"]),
};
