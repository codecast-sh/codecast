// Issue sync tables and validators. docs/architecture/issue-sync.md S1.
//
// A task's provider twin lives ON the task row (`tasks.external`) so it rides
// the sync log and reaches every surface with the task. The containers we
// import from (a Linear project or team, a GitHub repo) are rows here.

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const issueProviderValidator = v.union(v.literal("linear"), v.literal("github"));

/** S1.1 */
export const taskExternalValidator = v.object({
  provider: issueProviderValidator,
  id: v.string(),
  identifier: v.string(),
  url: v.string(),
  number: v.optional(v.number()),
  repo: v.optional(v.string()),
  team_key: v.optional(v.string()),
  team_id: v.optional(v.string()),
  project_id: v.optional(v.string()),
  source_id: v.optional(v.id("issue_sync_sources")),
  remote_updated_at: v.number(),
  synced_at: v.number(),
  field_ts: v.optional(v.record(v.string(), v.number())),
  assignee_label: v.optional(v.string()),
  state_name: v.optional(v.string()),
  last_error: v.optional(v.string()),
});

/** S1.2 */
export const taskCommentExternalValidator = v.object({
  provider: issueProviderValidator,
  id: v.string(),
  url: v.optional(v.string()),
  author: v.optional(v.string()),
});

export const issueSyncSourceKindValidator = v.union(
  v.literal("linear_project"),
  v.literal("linear_team"),
  v.literal("github_repo"),
);

export const issueSyncTables = {
  /** S1.3: one imported container -> one codecast project. */
  issue_sync_sources: defineTable({
    provider: issueProviderValidator,
    kind: issueSyncSourceKindValidator,
    external_id: v.string(),
    external_key: v.optional(v.string()),
    name: v.string(),
    url: v.optional(v.string()),
    project_id: v.id("projects"),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("error")),
    last_synced_at: v.optional(v.number()),
    last_webhook_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    delegate_label: v.optional(v.string()),
    delegate_assignee: v.optional(v.string()),
    auto_spawn: v.boolean(),
    push_new_tasks: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_project", ["project_id"])
    .index("by_provider_external", ["provider", "external_id"])
    .index("by_workspace", ["workspace"])
    .index("by_team_id", ["team_id"])
    .index("by_status", ["status"]),

  /** S1.4: inbound dedupe + audit, mirrors github_webhook_events. */
  linear_webhook_events: defineTable({
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
    processed: v.boolean(),
    created_at: v.number(),
  })
    .index("by_delivery_id", ["delivery_id"])
    .index("by_processed", ["processed"]),
};
