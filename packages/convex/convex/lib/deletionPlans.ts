// What a permanent delete reaches, as purge trees (lib/purgeTree.ts): a
// conversation, a published page, a call, and a whole team. Built on first
// use rather than at module load, so the modules they import may import this
// one back without a load-order trap.
//
// The coverage map (which tables hold a conversation's or a team's content,
// and which are left out and why) is checked against the schema by
// regulatedDeletion.test.ts, so a new table that holds content cannot slip past.
import { CONVERSATION_ROW_TABLES, conversationRowEffects } from "./conversationRows";
import { addCount, deleteStored, type PurgeNode } from "./purgeTree";
import { purgeCallRecordings, deleteCallFrameShares } from "./callRecordingRuns";
import { purgeThread } from "../threadReads";
import { killConversation } from "../conversations";

const idOf = (row: any) => row._id;
const workspaceOf = (team: any) => `team:${team._id}`;

/** A node keyed by the parent's id. */
function under(table: string, index: string, field: string, more: Partial<PurgeNode> = {}): PurgeNode {
  return { table, index, field, value: idOf, ...more };
}

// Rows big enough (message text, tool input, diff bodies, transcripts) that a
// page of them is read small and each costs more of a pass's budget.
const HEAVY = { page: 25, weight: 10 } as const;
const HEAVY_TABLES = new Set([
  "messages", "message_thinking", "message_tool_inputs", "file_change_bodies",
  "conversation_git_diffs", "conversation_context", "tree_snapshots", "transcript_segments",
]);

let built: {
  artifact: PurgeNode;
  conversationRows: ReadonlyArray<PurgeNode>;
  conversation: Omit<PurgeNode, "table" | "index" | "field" | "value">;
  call: Omit<PurgeNode, "table" | "index" | "field" | "value">;
  teamSteps: ReadonlyArray<PurgeNode>;
} | null = null;

function plans() {
  if (built) return built;

  // ── A published page ────────────────────────────────────────────────────
  const artifactRows: PurgeNode[] = [
    under("artifact_versions", "by_artifact", "artifact_id", {
      before: async (ctx, row, counts) => {
        await deleteStored(ctx, counts, row.storage_id);
        await deleteStored(ctx, counts, row.source_storage_id);
      },
    }),
    // Every version's bundle files, the current one's included.
    under("artifact_assets", "by_artifact_version", "artifact_id", {
      before: async (ctx, row, counts) => deleteStored(ctx, counts, row.storage_id),
    }),
    under("artifact_comments", "by_artifact", "artifact_id"),
    under("artifact_stats", "by_artifact", "artifact_id"),
    under("artifact_viewers", "by_artifact_email", "artifact_id"),
    under("page_queries", "by_artifact", "artifact_id"),
    under("page_query_sets", "by_artifact_version", "artifact_id"),
  ];
  const artifactBase = {
    children: artifactRows,
    before: async (ctx: any, row: any, counts: any) => {
      addCount(counts, "thread_reads", await purgeThread(ctx, "page", String(row._id)));
      await deleteStored(ctx, counts, row.storage_id);
      await deleteStored(ctx, counts, row.source_storage_id);
      await deleteStored(ctx, counts, row.thumb_storage_id);
    },
  };
  const artifact: PurgeNode = { table: "artifacts", index: "by_slug", field: "slug", value: (p) => p.slug, ...artifactBase };

  // ── A conversation ──────────────────────────────────────────────────────
  const message: Partial<PurgeNode> = {
    ...HEAVY,
    // The search mirror's copy and the send record go with the message.
    children: [
      under("message_search_recent", "by_message_id", "message_id"),
      under("user_sends", "by_message", "message_id"),
    ],
    before: async (ctx, row, counts) => {
      for (const f of [...(row.images ?? []), ...(row.files ?? [])]) await deleteStored(ctx, counts, f.storage_id);
    },
  };
  const conversationRows: PurgeNode[] = [
    ...CONVERSATION_ROW_TABLES.map(([table, index]): PurgeNode =>
      under(table, index, "conversation_id", {
        ...(HEAVY_TABLES.has(table) ? HEAVY : {}),
        ...(table === "messages" ? message : {}),
        before: async (ctx, row, counts) => {
          await conversationRowEffects(ctx, table, row);
          if (table === "messages") await message.before!(ctx, row, counts);
        },
      })),
    // Beyond the ordinary session purge: the content a regulated delete
    // must also reach.
    under("tree_snapshots", "by_conversation_taken", "conversation_id", HEAVY),
    under("conversation_events", "by_conversation_ts", "conversation_id"),
    under("session_starts", "by_conversation", "conversation_id"),
    under("session_guests", "by_conversation_created", "conversation_id"),
    under("guest_suggestions", "by_conversation_status", "conversation_id"),
    under("usage_pending", "by_conversation_day", "conversation_id"),
    under("assistant_turns", "by_conversation_status", "conversation_id"),
    under("assistant_history", "by_conversation", "conversation_id"),
    under("ship_runs", "by_conversation", "conversation_id"),
    under("org_role_tokens", "by_conversation_day", "conversation_id"),
    under("change_story_inputs", "by_conversation", "conversation_id"),
    under("chat_channel_agents", "by_conversation", "conversation_id"),
    under("authority_events", "by_conversation_created", "conversation_id"),
    // Pages published from the session carry its content.
    { ...artifactBase, table: "artifacts", index: "by_session_conversation", field: "session_conversation_id", value: idOf },
  ];
  // A conversation row itself, when a team's delete reaches it: the agent is
  // torn down and a tombstone keeps the owner's daemon from uploading the
  // transcript again (lib/deletedSessions).
  const conversation = {
    children: conversationRows,
    before: async (ctx: any, row: any) => {
      if (row.status === "active") {
        await killConversation(ctx, row.user_id, { conversation_id: row._id, mark_completed: true }, { cause: "delete" });
      }
      if (row.session_id) {
        await ctx.db.insert("deleted_sessions", {
          user_id: row.user_id,
          session_id: row.session_id,
          conversation_id: String(row._id),
          deleted_at: Date.now(),
        });
      }
    },
  };

  // ── A call: its record, transcript and recordings ───────────────────────
  const call = {
    children: [
      under("transcript_segments", "by_transcript_seq", "transcript_id", HEAVY),
      under("call_guest_attendance", "by_transcript", "transcript_id"),
      under("call_chat_messages", "by_transcript", "transcript_id"),
      under("call_agent_feeds", "by_transcript", "transcript_id"),
      under("call_session_links", "by_transcript", "transcript_id"),
    ],
    before: async (ctx: any, row: any, counts: any) => {
      // Rows, loops and the call's whole prefix in the recordings bucket;
      // null while a file is still being written, so the call waits.
      const recordings = await purgeCallRecordings(ctx, row._id);
      if (recordings === null) return "wait" as const;
      addCount(counts, "call_recordings", recordings);
      addCount(counts, "call_frame_shares", await deleteCallFrameShares(ctx, row._id));
      await deleteStored(ctx, counts, row.recording_storage_id);
    },
  };

  // ── A whole team, in order: sessions, calls, work, then everything keyed
  // by the team's routing id or its workspace, and its sync log last ──────
  const byTeam = (table: string, index: string, more: Partial<PurgeNode> = {}) => under(table, index, "team_id", more);
  const byWorkspace = (table: string, index: string, more: Partial<PurgeNode> = {}): PurgeNode =>
    ({ table, index, field: "workspace", value: workspaceOf, ...more });
  const byScope = (table: string, index: string): PurgeNode => ({ table, index, field: "scope_key", value: workspaceOf });

  const taskRows = [
    under("task_comments", "by_task_id", "task_id"),
    under("task_history", "by_task_id", "task_id"),
    { ...artifactBase, table: "artifacts", index: "by_task", field: "task_id", value: idOf },
  ];
  const planRows = [
    under("progress_events", "by_plan_id", "plan_id"),
    under("orchestration_events", "by_plan_id", "plan_id"),
    { ...artifactBase, table: "artifacts", index: "by_plan", field: "plan_id", value: idOf },
  ];
  const docRows = [
    { table: "doc_snapshots", index: "id_version", field: "id", value: (d: any) => String(d._id), ...HEAVY },
    { table: "doc_deltas", index: "id_version", field: "id", value: (d: any) => String(d._id) },
    under("doc_presence", "by_doc", "doc_id"),
    under("data_queries", "by_doc_qkey", "doc_id"),
    under("live_search", "by_doc", "doc_id"),
  ];
  const channelRows = [
    under("chat_messages", "by_channel_created", "channel_id", { children: [under("chat_reactions", "by_message", "message_id")] }),
    under("chat_reactions", "by_channel", "channel_id"),
    under("chat_channel_members", "by_channel", "channel_id"),
    under("chat_typing", "by_channel_updated", "channel_id"),
    under("thread_reads", "by_channel", "channel_id"),
  ];
  const modRows = [
    under("mod_versions", "by_mod_version", "mod_id"),
    under("mod_state", "by_mod_key", "mod_id"),
    under("mod_calls", "by_mod_created", "mod_id"),
    under("mod_logs", "by_mod_created", "mod_id"),
    under("mod_secrets", "by_mod_name", "mod_id"),
  ];
  const secretRows = [
    under("secret_versions", "by_secret", "secret_id"),
    under("secret_values", "by_secret", "secret_id"),
    under("secret_events", "by_secret_at", "secret_id"),
    under("secret_approvals", "by_secret_conversation", "secret_id"),
  ];

  const teamSteps: PurgeNode[] = [
    byTeam("conversations", "by_team_id", { ...conversation, page: 10 }),
    byTeam("transcripts", "by_team_started", { ...call, page: 10 }),
    byTeam("tasks", "by_team_id", { children: taskRows }),
    byWorkspace("tasks", "by_workspace", { children: taskRows }),
    byTeam("plans", "by_team_id", { children: planRows }),
    byWorkspace("plans", "by_workspace", { children: planRows }),
    byTeam("docs", "by_team_id", { children: docRows, ...HEAVY }),
    byWorkspace("docs", "by_workspace", { children: docRows, ...HEAVY }),
    byTeam("projects", "by_team_id"),
    byWorkspace("projects", "by_workspace"),
    byTeam("initiatives", "by_team_id"),
    byWorkspace("initiatives", "by_workspace"),
    byTeam("workflows", "by_team_id", { children: [under("workflow_versions", "by_workflow_at", "workflow_id")] }),
    byWorkspace("workflows", "by_workspace", { children: [under("workflow_versions", "by_workflow_at", "workflow_id")] }),
    byWorkspace("workflow_runs", "by_workspace_updated"),
    byTeam("decisions", "by_team_id"),
    byWorkspace("decisions", "by_workspace"),
    byTeam("patterns", "by_team_id"),
    byWorkspace("patterns", "by_workspace"),
    byTeam("session_insights", "by_team_generated_at"),
    byTeam("session_decisions", "by_team_status_created", {
      before: async (ctx, row) => conversationRowEffects(ctx, "session_decisions", row),
    }),
    byTeam("decision_stacks", "by_team"),
    byTeam("commits", "by_team_timestamp"),
    byTeam("pull_requests", "by_team_id"),
    byTeam("team_activity_events", "by_team_id"),
    byTeam("chat_channels", "by_team_name", { children: channelRows }),
    byTeam("external_events", "by_team_created"),
    byWorkspace("external_events", "by_workspace_created"),
    byTeam("day_timelines", "by_team_date"),
    byTeam("digests", "by_team_scope_date"),
    byTeam("change_stories", "by_team_date"),
    byTeam("change_dirty", "by_key"),
    byTeam("saved_views", "by_team_id"),
    byTeam("plan_templates", "by_team_id"),
    byTeam("change_log", "by_team_seq"),
    byTeam("user_sends", "by_team_timestamp"),
    byTeam("mods", "by_team_id", { children: modRows }),
    byWorkspace("mod_objects", "by_workspace_updated"),
    byTeam("agent_definitions", "by_team_id"),
    byWorkspace("agent_definitions", "by_workspace"),
    byTeam("agent_chains", "by_team_id"),
    byWorkspace("agent_chains", "by_workspace"),
    byTeam("issue_sync_sources", "by_team_id"),
    byWorkspace("issue_sync_sources", "by_workspace"),
    byTeam("org_roles", "by_team", { children: [under("org_role_history", "by_role", "role_id")] }),
    byTeam("org_proposals", "by_team", { children: [under("org_proposal_changes", "by_proposal", "proposal_id")] }),
    byWorkspace("org_change_batches", "by_workspace"),
    byWorkspace("org_changes", "by_workspace_seq"),
    byWorkspace("org_templates", "by_workspace"),
    byWorkspace("org_template_instances", "by_workspace"),
    byWorkspace("org_template_learning", "by_workspace"),
    byTeam("anchors", "by_team"),
    byTeam("live_flows", "by_team"),
    byWorkspace("live_flows", "by_workspace"),
    byWorkspace("flow_map_rollups", "by_workspace"),
    byWorkspace("session_flows", "by_workspace_hash"),
    byWorkspace("landed_changes", "by_workspace_landed"),
    byWorkspace("project_memory", "by_workspace_project"),
    byWorkspace("project_expectations", "by_workspace_prefix"),
    byWorkspace("signals", "by_workspace_created"),
    byWorkspace("secrets", "by_workspace", { children: secretRows }),
    byWorkspace("secret_events", "by_workspace_at"),
    byWorkspace("event_sources", "by_workspace_name"),
    byWorkspace("event_groups", "by_workspace_last_seen"),
    byWorkspace("event_samples", "by_workspace_at"),
    byWorkspace("replays", "by_workspace_started", { children: [under("replay_timelines", "by_replay", "replay_id")] }),
    byWorkspace("replay_tallies", "by_workspace"),
    byWorkspace("metric_watches", "by_workspace", { children: [under("metric_points", "by_watch_at", "watch_id")] }),
    byWorkspace("moments", "by_workspace_created", { children: [under("judge_runs", "by_moment", "moment_id")] }),
    byWorkspace("judge_runs", "by_workspace_at"),
    byWorkspace("problem_merge_checks", "by_workspace"),
    byWorkspace("team_budgets", "by_workspace"),
    byWorkspace("model_spend_hours", "by_workspace_hour"),
    byWorkspace("deploy_targets", "by_workspace_repository"),
    byWorkspace("deploys", "by_workspace_created"),
    byWorkspace("ship_passes", "by_workspace_finished"),
    byWorkspace("trial_cards", "by_workspace_created"),
    byWorkspace("line_labels", "by_workspace_at"),
    byWorkspace("team_kit_items", "by_workspace_updated", { children: [under("team_kit_versions", "by_item_version", "item_id")] }),
    // The team's own configuration and the people and machines tied to it.
    byTeam("team_invites", "by_team_email"),
    byTeam("team_join_requests", "by_team_status"),
    byTeam("team_memberships", "by_team_id"),
    byTeam("directory_team_mappings", "by_team_id"),
    byTeam("call_members", "by_team"),
    byTeam("device_shares", "by_team"),
    byTeam("team_hosts", "by_team", { children: [under("team_host_members", "by_host", "host_id")] }),
    byTeam("account_shares", "by_team"),
    byTeam("team_enrollment_tokens", "by_team"),
    byTeam("device_enrollments", "by_team"),
    byTeam("capability_bindings", "by_team_updated"),
    byTeam("capability_events", "by_team_created"),
    byTeam("slack_channel_links", "by_team"),
    byTeam("slack_installations", "by_team"),
    byTeam("github_app_installations", "by_team_id"),
    byTeam("repo_cache", "by_team_fetched"),
    byTeam("repo_sources", "by_team_id"),
    // The sync log last: every delete above wrote its tombstone into it.
    byScope("sync_actions", "by_scope_position"),
    byScope("sync_outbox", "by_scope_entity"),
    byScope("sync_heads", "by_scope"),
  ];

  built = { artifact, conversationRows, conversation, call, teamSteps };
  return built;
}

/** A published page and everything it owns, keyed by slug. */
export const artifactPlan = () => plans().artifact;
/** The rows one conversation owns (the conversation row itself is not among them). */
export const conversationRowPlan = () => plans().conversationRows;
/** The steps of a whole team's delete, run in order against the team row. */
export const teamDeletionSteps = () => plans().teamSteps;
/** A call record, with `table` etc. filled by the caller's lookup. */
export const callPlan = (): PurgeNode => ({ table: "transcripts", index: "by_team_started", field: "team_id", value: (p) => p._id, ...plans().call });

/**
 * Tables that carry a conversation, team, workspace or call key but that no
 * plan above reaches, and why. regulatedDeletion.test.ts fails when a table
 * with such a key is in neither a plan nor this map.
 */
export const LEFT_OUT: Record<string, string> = {
  // Reached through a plan's `before` work rather than a node of their own.
  call_recordings: "deleted by purgeCallRecordings in the call plan",
  call_frame_shares: "deleted by purgeCallRecordings and deleteCallFrameShares in the call plan",
  // Kept on purpose.
  data_deletions: "the record of each delete; it must outlive the data",
  access_log: "the audit log; it must outlive the data",
  deleted_sessions: "tombstones that stop a daemon re-uploading a deleted transcript",
  users: "accounts belong to people, not to the team; retireTeam repoints their team",
  team_subscriptions: "billing records",
  user_send_daily: "per-person counts, no content",
  user_usage_daily: "per-person counts, no content",
  user_activity_daily: "per-person counts, no content",
  project_task_counts: "counts, no content",
  // Per-person pointers, indexed by person first: no index reaches them from the conversation.
  inbox_hides: "per-person pointer, no conversation-leading index",
  bookmarks: "per-person pointer, no conversation-leading index",
  bucket_assignments: "per-person pointer, no conversation-leading index",
  session_reads: "per-person pointer, no conversation-leading index",
  view_states: "per-person pointer, no conversation-leading index",
  notifications: "indexed by recipient first; may hold a preview line (open follow-up: needs a conversation index)",
  chat_reads: "per-person read marker",
  decision_grants: "per-person grant",
  // No index leads on the key, so reaching them means a table scan (open follow-up: add an index).
  public_conversations: "no conversation index; holds a preview of a directory-published session (open follow-up: index it, or gate publishToDirectory for regulated teams)",
  suggestion_outcomes: "no conversation index",
  project_updates: "no conversation index",
  project_update_comments: "no conversation index",
  wallet_ledger: "no conversation index (hosted assistant spend)",
  move_rehearsals: "no conversation index (short-lived move scratch)",
  app_calls: "no team or workspace index",
  judges: "no team or workspace index",
  agent_reviews: "no team or workspace index",
  commit_ci: "no team or workspace index",
  signal_vectors: "no workspace index",
  moment_extractors: "no workspace index",
  event_source_stats: "no workspace index",
  org_template_lessons: "no workspace index",
  weekly_cards: "no workspace index",
  push_ring: "no workspace index",
  initiative_updates: "no team or workspace index",
  expectation_proposals: "no team or workspace index",
  line_tries: "no team or workspace index",
  app_installations: "indexed by provider first",
  repo_read_requests: "no team index",
  github_app_install_intents: "no team index",
  call_invites: "keyed by room, not team",
  call_room_state: "keyed by room, not team",
  call_knocks: "keyed by room, not team",
  call_guest_links: "keyed by room, not team",
  call_guests: "keyed by room, not team",
  artifact_identities: "indexed by person first (a page viewer's sign-in token)",
  // A different scope vocabulary than team:<id>.
  capability_state: "scope_key is a capability scope, not a team",
  tidemark_activities: "scope_key is the hosted assistant's scope",
  tidemark_blocks: "scope_key is the hosted assistant's scope",
  tidemark_logs: "scope_key is the hosted assistant's scope",
  tidemark_memories: "scope_key is the hosted assistant's scope",
};
