import { defineTable } from "convex/server";
import { v } from "convex/values";

/** What a person (or Codecast staff) did with a regulated team's data. */
export const accessActionValidator = v.union(
  v.literal("open"),
  v.literal("export"),
  v.literal("download"),
  v.literal("staff_read"),
  // A regulated-data deletion (dataDeletions), one per object deleted; detail carries the row counts.
  v.literal("delete"),
);

/** Where the access came from: an app, the CLI, a published page in a plain browser, or a staff script. */
export const accessClientValidator = v.union(
  v.literal("web"),
  v.literal("desktop"),
  v.literal("mobile"),
  v.literal("cli"),
  v.literal("page"),
  v.literal("script"),
);

/**
 * The audit log of data access (lib/accessLog.ts recordAccess), written only
 * for teams whose managed policy sets regulated_data. Read by one paged
 * settings query (accessLog.listForTeam) and nothing else: it is in no sync
 * registry and no subscription the inbox holds reads it.
 */
export const accessLogTables = {
  access_log: defineTable({
    // Absent only on a staff read whose arguments name no team's object.
    team_id: v.optional(v.id("teams")),
    // A signed-in person, or a label for whoever has no account row here
    // (a staff git identity and machine, a page link holder).
    actor_user_id: v.optional(v.id("users")),
    actor_label: v.optional(v.string()),
    action: accessActionValidator,
    object_table: v.string(),
    object_id: v.string(),
    object_short_id: v.optional(v.string()),
    client: accessClientValidator,
    // A file name for a download; the function and its arguments for a staff read.
    detail: v.optional(v.string()),
    at: v.number(),
    // actor + action + object: repeat opens inside the debounce share one row.
    repeat_key: v.string(),
  })
    .index("by_team_at", ["team_id", "at"])
    .index("by_repeat_key", ["repeat_key", "at"]),
};
