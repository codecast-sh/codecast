// ── Field ownership (design C1) ─────────────────────────────────────────────

// The overlay-owned FACT fields: one writer (sessionsLiveness / its team twin).
// The server strip list (every other sessions channel nulls these) and the
// client preserve list both derive from this constant, with a signature test,
// so no channel can write a torn or stale fact over a fresher one.
export const INBOX_FACT_FIELDS = [
  "agent_status",
  "is_idle",
  "is_unresponsive",
  "awaiting_input",
  "is_connected",
  "tmux_session",
  "permission_mode",
  "agent_started_at",
  "open_tasks",
  "open_tasks_at",
  "message_count",
  "updated_at",
  "last_turn_allows_park",
  // The is_idle inputs (ct-47609): everything deriveLiveAt needs to re-run the
  // server's idle, responsiveness and status trust rules at ANY instant, so
  // the +45s settle, the heartbeat lapse and the trust decay flip on the
  // replica's own clock instead of waiting for a server re-execution.
  "agent_status_updated_at",
  // The settle's own facts (ct-49533): whether it came from a lifecycle event
  // rather than a turn ending — which the replica must place exactly as the
  // server does — and which turn it belongs to, the identity a completion
  // consumer dedupes on when the status itself stops moving.
  "agent_status_boundary",
  "turn_completed_at",
  "hibernated_at",
  "last_heartbeat",
  "last_role_is_user",
  "auq_open",
  "daemon_alive_until",
  "producing_until",
  // A child of this row is asking (the asking rollup's child half), stamped
  // on member rows: the child may sit outside the replica's window (ct-56051).
  "child_asking",
  // When that child's ask stops counting (its heartbeat ages out of the live
  // pool, its status outlives its trust): the lift decays with time alone, so the
  // replica reads it at its own clock (childAskingAt). Null: no time bound.
  "child_asking_until",
  // A nested child of this row is live (a non-idle trusted status): what puts
  // a standing session in front of the person when its only work is a
  // subagent, which is never a member the ride can see.
  "child_live",
  // What the agent is doing right now (conversations.activity): stamped at
  // message ingest from the newest tool call, cleared when the turn settles.
  // Overlay borne so a tool call never changes the session list result; the
  // overlay already re-pushes on the same flush (updated_at is a fact).
  "activity",
  // What waking the session costs (wakeCost.ts): both move on every model
  // call, so on the base list they re-pushed the whole multi-MB session list
  // to every open tab about once a second (2026-10-01).
  "context_tokens",
  "last_model_call_at",
] as const;

export type InboxFactField = (typeof INBOX_FACT_FIELDS)[number];

// The inbox row's BODY fields: every key a base sessions channel writes
// besides the facts (enrichInboxSessionRow, stampInboxViewerFields and
// buildSubagentChildRow in conversations.ts). A row is an allowlist, not the
// raw conversation: sync-log cargo lands a raw field only when (after its
// rename) it is one of these, or the next list or byIds push would remove it
// again. A convex test pins this set to what those three functions write.
export const INBOX_ROW_FIELDS = [
  "_id", "session_id", "user_id", "team_id", "status", "is_private", "team_visibility",
  "title", "subtitle", "started_at", "agent_type", "model", "effort", "cc_account", "transcript_revision",
  "project_path", "git_root", "git_branch", "git_remote_url", "worktree_name", "worktree_branch",
  "parent_conversation_id", "parent_message_uuid", "spawned_by_conversation_id", "forked_from",
  "is_subagent", "is_workflow_sub", "is_workflow_primary", "agent_team_name", "agent_name",
  "handed_off_from_conversation_id", "handed_off_from_details", "handed_off_to_conversation_id", "handed_off_to_details",
  "implementation_session",
  "inbox_pinned_at", "is_pinned", "inbox_dismissed_at", "inbox_stashed_at", "inbox_stash_hidden",
  "inbox_snoozed_until", "inbox_killed_at", "is_deferred", "inbox_deferred_at", "inbox_rest", "inbox_rest_at", "user_rest",
  "settle_verdict", "is_favorite",
  "has_pending", "last_user_message", "pending_api_error", "pending_api_error_at", "pending_api_error_kind", "session_error", "hosted_stop",
  "idle_summary", "thread_state", "thread_state_at", "thread_state_msg_count", "thread_state_status",
  "open_comment_threads", "last_comment_at", "last_comment_author", "last_comment_author_id", "last_comment_excerpt",
  "active_plan", "active_task", "agent_task_id", "armed_trigger_kind", "loop_state", "pr_status",
  "workflow_run_id", "workflow_run_name", "workflow_run_status", "workflow_run_started_at",
  "workflow_run_activity", "workflow_run_agents_done", "workflow_run_agents_total",
  "anchor_id", "is_anchor", "org_role_id", "standing_role_id", "role", "acting_user_id",
  "character_avatar", "character_name", "drawn_icon", "icon", "icon_color", "image_preview_url", "browser_pane_offer",
  "owner_device_id", "owner_user_id", "author_avatar", "local_mirror", "migration_batch_id",
  "cloud_placement", "cloud_seed", "cloud_workspace", "cloud_context_too_large", "cloud_placement_progress",
  "subagent_slot", "subagent_slot_at", "subagent_slot_device", "subagent_caps", "merge_back",
  // The viewer stamps (stampInboxViewerFields).
  "owned_by_me", "author_name", "author_email", "assigned_ping", "owner_name", "owner_email",
] as const;

const INBOX_ROW_FIELD_SET: ReadonlySet<string> = new Set(INBOX_ROW_FIELDS);
/** Whether a key belongs on an inbox row's body (INBOX_ROW_FIELDS): what a
 *  client write may land on a cached sessions row. */
export const isInboxRowField = (key: string): boolean => INBOX_ROW_FIELD_SET.has(key);

// The projection STAMP fields — checking data, never render sources on a
// replica: stripped from every row channel, stored only in the client's
// per-scope sessionsProjection buffer, and never merged onto session rows.
// `bucket_stale_at` is a client recompute scheduling hint and payload
// staleness signal; `stale_bucket` is never rendered.
export const INBOX_PROJECTION_FIELDS = [
  "bucket",
  "work_state",
  "asking",
  "below_fold",
  "bucket_stale_at",
  "stale_bucket",
] as const;

export type InboxProjectionField = (typeof INBOX_PROJECTION_FIELDS)[number];
