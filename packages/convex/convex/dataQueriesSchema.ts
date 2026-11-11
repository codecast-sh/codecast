// Data dashboards (ct-91886): each distinct query a dashboard's blocks bind
// to, with its last answer. See dataQueries.ts.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dataQueryTables = {
  // One row per (dashboard doc, query key). The key is a hash of the
  // source and its args (shared/artifacts/dashboardData queryKey), so blocks
  // that read the same rows share one read. A query runs as the person who
  // first bound it (owner_user_id), inside the doc's workspace, the same
  // rule a published page's queries follow.
  data_queries: defineTable({
    doc_id: v.id("docs"),
    qkey: v.string(),
    source: v.string(),
    args_json: v.string(),
    /** The reader's own words for what ran, with the workspace. */
    query_text: v.string(),
    owner_user_id: v.id("users"),
    workspace: v.string(),
    refresh_ms: v.number(),
    result_json: v.optional(v.string()),
    truncated: v.optional(v.boolean()),
    refreshed_at: v.optional(v.number()),
    attempted_at: v.optional(v.number()),
    error: v.optional(v.string()),
    lease_until: v.optional(v.number()),
    /** Start time of the run whose outcome the row holds; a run that started earlier never overwrites it, success or failure. */
    run_started: v.optional(v.number()),
    /** Its reader refused the args or the source is gone; `error` says why. Re-checked on its interval, never run. */
    invalid: v.optional(v.boolean()),
    /** Last time a viewer's dashboard asked for it; rows nobody asks for in a day are dropped. */
    wanted_at: v.number(),
    created_at: v.number(),
  }).index("by_doc_qkey", ["doc_id", "qkey"]),
};
