import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { AGENT_STATUSES, DAEMON_COMMANDS } from "@codecast/shared/contracts";
import { ccAccountsValidator } from "./ccAccountsShared";
import { deviceSettingsValidator } from "./deviceSettingsShared";

// Derived from the single source of truth in @codecast/shared/contracts so the
// schema, validators, the CLI daemon, and the browser store can never drift.
// Each accepts exactly the same set as the old hand-written unions.
const agentStatusFieldValidator = v.union(
  ...AGENT_STATUSES.map((s) => v.literal(s)),
);
const daemonCommandValidator = v.union(
  ...DAEMON_COMMANDS.map((c) => v.literal(c)),
);

export default defineSchema({
  ...authTables,
  users: defineTable({
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    role: v.optional(v.union(v.literal("member"), v.literal("admin"))),
    // Synthetic agent identity (an Anchor's bot user). `is_bot` users have no
    // login and exist only to give a standing agent member its own name/avatar in
    // the author chip, team roster, and feed. They never host or bill a session —
    // a human (the anchor's host) does that; the bot is identity only. See anchors.
    is_bot: v.optional(v.boolean()),
    bot_kind: v.optional(v.union(v.literal("anchor"))),
    active_team_id: v.optional(v.id("teams")),
    daemon_last_seen: v.optional(v.number()),
    last_message_sent_at: v.optional(v.number()),
    prev_message_sent_at: v.optional(v.number()),
    work_cluster_started_at: v.optional(v.number()),
    theme: v.optional(v.union(v.literal("dark"), v.literal("light"))),
    github_id: v.optional(v.string()),
    github_username: v.optional(v.string()),
    github_avatar_url: v.optional(v.string()),
    github_access_token: v.optional(v.string()),
    push_token: v.optional(v.string()),
    notifications_enabled: v.optional(v.boolean()),
    notification_preferences: v.optional(v.object({
      team_session_start: v.boolean(),
      mention: v.boolean(),
      permission_request: v.boolean(),
      session_idle: v.optional(v.boolean()),
      session_error: v.optional(v.boolean()),
      task_activity: v.optional(v.boolean()),
      doc_activity: v.optional(v.boolean()),
      plan_activity: v.optional(v.boolean()),
    })),
    pr_auto_comment_enabled: v.optional(v.boolean()),
    bio: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.optional(v.union(v.literal("available"), v.literal("busy"), v.literal("away"))),
    timezone: v.optional(v.string()),
    hide_activity: v.optional(v.boolean()),
    // Public-profile opt-in. A claimed, unique handle (lowercase alnum+dash) that
    // forms the anonymous URL /u/<username>; github_username only pre-fills the
    // suggestion. `public_profile_enabled` is the master switch — until it's true
    // the public page 404s for everyone. See privacy.ts (public visibility tier).
    username: v.optional(v.string()),
    public_profile_enabled: v.optional(v.boolean()),
    share_session_metadata: v.optional(v.boolean()),
    activity_visibility: v.optional(v.union(
      v.literal("detailed"),
      v.literal("summary"),
      v.literal("minimal"),
      v.literal("hidden")
    )),
    encryption_enabled: v.optional(v.boolean()),
    encryption_master_key: v.optional(v.string()),
    sync_mode: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    sync_projects: v.optional(v.array(v.string())),
    team_share_paths: v.optional(v.array(v.string())),
    muted_members: v.optional(v.array(v.id("users"))),
    team_conversations_last_seen: v.optional(v.number()),
    cli_version: v.optional(v.string()),
    cli_platform: v.optional(v.string()),
    autostart_enabled: v.optional(v.boolean()),
    has_tmux: v.optional(v.boolean()),
    daemon_pid: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
    // Sync backlog reported on each heartbeat. Lets the web show a "sync
    // stalled" warning while the daemon is alive but data isn't flowing.
    // count = logical ops (per-conversation), messages/conversations = honest
    // backlog depth, oldest_pending_ms = how far behind the oldest queued item.
    daemon_pending_sync_count: v.optional(v.number()),
    daemon_oldest_pending_ms: v.optional(v.number()),
    daemon_pending_sync_messages: v.optional(v.number()),
    daemon_pending_sync_conversations: v.optional(v.number()),
    agent_permission_modes: v.optional(v.object({
      claude: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
      codex: v.optional(v.union(v.literal("default"), v.literal("full_auto"), v.literal("bypass"))),
      gemini: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
    })),
    agent_default_params: v.optional(v.object({
      claude: v.optional(v.record(v.string(), v.string())),
      codex: v.optional(v.record(v.string(), v.string())),
      gemini: v.optional(v.record(v.string(), v.string())),
      cursor: v.optional(v.record(v.string(), v.string())),
    })),
    available_agents: v.optional(v.array(v.object({
      name: v.string(),
      description: v.optional(v.string()),
    }))),
    available_skills: v.optional(v.string()),
    // Paths the running daemon can see on this user's machine. Published on
    // every heartbeat. Used by the project switcher to hide "ghost" folders
    // that exist on another device the user owns but not on this one.
    local_project_roots: v.optional(v.array(v.string())),
    local_project_roots_updated_at: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("by_github_username", ["github_username"])
    .index("by_github_id", ["github_id"])
    .index("by_username", ["username"])
    .index("by_team_id", ["team_id"])
    .index("by_last_heartbeat", ["last_heartbeat"]),

  daemon_commands: defineTable({
    user_id: v.id("users"),
    command: daemonCommandValidator,
    args: v.optional(v.string()),
    created_at: v.number(),
    executed_at: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    // Device this command is routed to. When set, only the daemon whose
    // deviceId() matches executes it — the poll filters the rest out, so
    // session commands (start/resume) go to the one machine that owns the
    // checkout instead of being raced by every daemon. Undefined = broadcast
    // (device-agnostic commands like status/restart, or sessions whose owner
    // can't be resolved yet).
    target_device_id: v.optional(v.string()),
  }).index("by_user_pending", ["user_id", "executed_at"]),

  teams: defineTable({
    name: v.string(),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    created_at: v.number(),
    invite_code: v.string(),
    invite_code_expires_at: v.optional(v.number()),
  }).index("by_invite_code", ["invite_code"]),

  team_memberships: defineTable({
    user_id: v.id("users"),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
    joined_at: v.number(),
    visibility: v.optional(v.union(
      v.literal("hidden"),
      v.literal("activity"),
      v.literal("summary"),
      v.literal("full")
    )),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_user_team", ["user_id", "team_id"]),

  directory_team_mappings: defineTable({
    user_id: v.id("users"),
    path_prefix: v.string(),
    team_id: v.id("teams"),
    auto_share: v.boolean(),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_team", ["user_id", "team_id"])
    .index("by_team_id", ["team_id"]),

  conversations: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("cowork")
    ),
    session_id: v.string(),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    title_embedding: v.optional(v.array(v.float64())),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    model: v.optional(v.string()),
    // Last-known effort level (low|medium|high|max), same lifecycle as `model`:
    // stamped optimistically by the web picker / at create, confirmed by the
    // rollup parsing "Set effort level to X" / "with X effort" switch echoes.
    effort: v.optional(v.string()),
    started_at: v.number(),
    updated_at: v.number(),
    message_count: v.number(),
    is_private: v.boolean(),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),
    status: v.union(v.literal("active"), v.literal("completed")),
    share_token: v.optional(v.string()),
    parent_message_uuid: v.optional(v.string()),
    parent_conversation_id: v.optional(v.id("conversations")),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    git_status: v.optional(v.string()),
    git_root: v.optional(v.string()),
    fork_count: v.optional(v.number()),
    forked_from: v.optional(v.id("conversations")),
    // Fork-copy progress (set on the fork target, not the source). The fork
    // mutation chain reads/writes these to copy >8192-message conversations
    // across multiple transactions without hitting Convex's per-mutation write
    // limit. Absence means "not a fork in progress".
    //   - fork_status: "copying" while batches are being copied; "complete"
    //     once finalized; "failed" if a watchdog marks it.
    //   - fork_copy_total: messages we expect to copy.
    //   - fork_copied: messages copied so far (kept in sync with message_count).
    //   - fork_copy_cursor: timestamp of the last message copied; the next
    //     batch reads messages where timestamp > this cursor.
    //   - fork_cutoff_timestamp: upper bound for partial forks (forked at a
    //     specific message). Absent = full copy.
    //   - fork_daemon_args: JSON args for the daemon_commands row to insert
    //     once copy completes; kept here so the daemon can't race a half-copied
    //     fork.
    fork_status: v.optional(v.union(v.literal("copying"), v.literal("complete"), v.literal("failed"))),
    fork_copy_total: v.optional(v.number()),
    fork_copied: v.optional(v.number()),
    fork_copy_cursor: v.optional(v.number()),
    fork_cutoff_timestamp: v.optional(v.number()),
    fork_daemon_args: v.optional(v.string()),
    // Comment-thread agent reply: this conversation is a hidden fork spawned to
    // answer in a teammate comment thread. It points back at the parent
    // conversation, the anchored message (if any), and the placeholder comment to
    // mirror the reply into; comment_fork_prompt_at separates the agent's new
    // reply from the copied parent history (any assistant message newer than it
    // is the reply). Hidden from the feed via is_subagent.
    comment_fork_parent: v.optional(v.id("conversations")),
    comment_fork_message_id: v.optional(v.string()),
    comment_fork_comment_id: v.optional(v.id("comments")),
    comment_fork_prompt_at: v.optional(v.number()),
    // Visible-child pointer: the session that spawned this one (agent-team
    // teammate → its lead, `cast spawn` → its caller). Unlike
    // parent_conversation_id — whose mere presence marks a row as a subagent
    // and nests/hides it from the inbox — this field only labels and links:
    // the child stays a first-class inbox card with a click-through to its
    // parent. Set by conversations.linkSpawnedBy (daemon-resolved).
    spawned_by_conversation_id: v.optional(v.id("conversations")),
    // Agent-team identity, from the teamName/agentName stamps Claude Code
    // writes on every teammate JSONL line (the lead's transcript is never
    // stamped; linkSpawnedBy stamps the lead as "team-lead" when it links a
    // worker). Lets the client resolve a teammate name in a transcript to the
    // sibling session that carries it.
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    is_favorite: v.optional(v.boolean()),
    short_id: v.optional(v.string()),
    auto_shared: v.optional(v.boolean()),
    skip_title_generation: v.optional(v.boolean()),
    title_is_custom: v.optional(v.boolean()),
    idle_summary: v.optional(v.string()),
    // Dedupe for the needs-input push: "<message_count>:<kind>" of the last
    // waiting episode already notified (see notifications.checkNeedsInput).
    // Mirrors the web idle-sound's notified-keys map so one episode pushes
    // once but each new turn can push again.
    needs_input_notified_key: v.optional(v.string()),
    // Absolute flag: a truthy value means dismissed until a user action clears
    // it. Never compare against `updated_at` — dozens of mutations bump that
    // field and a relative check re-opens the session. Set by:
    // dismissFromInbox, linkSessions*, linkPlanHandoff (auto-dismiss parent),
    // killSession-adjacent paths. Cleared only by: dispatch.sendMessage,
    // pendingMessages.create, inboxStore.restoreSession, adminUnlinkSession.
    // The list predicates live in inboxFilters.ts. Dismiss also KILLS the
    // agent (dispatch.applyPatches enqueues kill_session on the transition).
    inbox_dismissed_at: v.optional(v.number()),
    // Stash = set aside WITHOUT killing: hides the session from the active inbox
    // buckets into the "Stashed" group (above Dismissed) while the agent keeps
    // running. Same absolute-flag semantics as inbox_dismissed_at (cleared by
    // a HUMAN send or an explicit restore — a scheduler-origin injection
    // deliberately leaves it set, see enqueuePendingMessage); unlike dismiss it
    // never triggers a kill. A dismiss clears it (the row moves to Dismissed).
    inbox_stashed_at: v.optional(v.number()),
    inbox_killed_at: v.optional(v.number()),
    inbox_deferred_at: v.optional(v.number()),
    inbox_pinned_at: v.optional(v.number()),
    // Distinct from inbox_pinned_at: this is the PUBLIC-profile pin. Setting it
    // is the consent act that makes a session world-visible (the mutation also
    // guarantees a share_token, so the card deep-links to the existing /share
    // guest viewer). Timestamp = curation order, GitHub-pinned-repos style.
    profile_pinned_at: v.optional(v.number()),
    draft_message: v.optional(v.string()),
    last_user_message_at: v.optional(v.number()),
    is_subagent: v.optional(v.boolean()),
    cli_flags: v.optional(v.string()),
    last_message_role: v.optional(v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    )),
    last_message_preview: v.optional(v.string()),
    has_pending_messages: v.optional(v.boolean()),
    // True while the conversation's newest message is a transient Claude Code
    // API/auth-error banner (see isApiErrorBanner). Cleared when a real turn
    // supersedes it. Gates the banner-cleanup scan in addMessages so the common
    // (no-error) write path never pays for the extra read.
    pending_api_error: v.optional(v.boolean()),
    // Which banner family parked the session ("auth" | "limit" | "error", see
    // classifyApiErrorBanner) — drives the session-card pill label (login vs
    // limit). Set/cleared in lockstep with pending_api_error.
    pending_api_error_kind: v.optional(v.string()),
    session_error: v.optional(v.string()),
    active_plan_id: v.optional(v.id("plans")),
    active_task_id: v.optional(v.id("tasks")),
    plan_ids: v.optional(v.array(v.id("plans"))),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    worktree_status: v.optional(v.union(
      v.literal("active"),
      v.literal("merged"),
      v.literal("archived")
    )),
    workflow_run_id: v.optional(v.id("workflow_runs")),
    is_workflow_sub: v.optional(v.boolean()),
    is_workflow_primary: v.optional(v.boolean()),
    // The schedule (agent_tasks row) that spawned this conversation as a run.
    // Stamped by the daemon shortly after spawn (agentTasks.linkRunConversation)
    // and backfilled on run completion/failure, so EVERY run — not just the
    // latest — stays attributable to its schedule (panel, badges, provenance).
    agent_task_id: v.optional(v.id("agent_tasks")),
    available_skills: v.optional(v.string()),
    subagent_description: v.optional(v.string()),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    // Which device currently OWNS (runs) this session. Set by the managing
    // daemon. Absent = legacy/unowned. The single-owner invariant: a daemon
    // only manages sessions whose owner_device_id matches its own device id.
    // "Move to remote" flips this from the local device to the Mac's device.
    owner_device_id: v.optional(v.string()),
    // Second-party ownership: the team member RESPONSIBLE for this session,
    // distinct from user_id (the member whose account runs it). Set when an
    // agent account (e.g. Mr Bot) parks a session on a human reviewer — the
    // session then surfaces in the owner's inbox/CLI needs-input views and the
    // owner may reply into it from the web composer. Absent = unowned, classic
    // behavior. Unrelated to owner_device_id (which DEVICE's daemon runs it).
    owner_user_id: v.optional(v.id("users")),
    // Tombstone forwarding: the id of a DELETED conversation this row replaced
    // when a kill/restart restored its session (resolveRestartTarget). Lets
    // resolveConversation heal stale links/cards that still point at the dead
    // id. A plain string — the referenced row no longer exists.
    restored_from_conversation_id: v.optional(v.string()),
    // ── Anchor / persistent-session support ──────────────────────────────────
    // `persistent` exempts a conversation from auto-completion so a standing
    // agent member can sit dormant indefinitely and be re-woken by an event. The
    // guard lives in markSessionCompleted (covers the watchdog, SessionEnd hook,
    // daemon kill teardown) plus matching checks in the direct-patch kill paths
    // (killSession + dispatch dismiss→kill). It is flipped to "completed" only by
    // decommissionAnchor, which clears `persistent` first.
    persistent: v.optional(v.boolean()),
    // The IDENTITY a session renders as. When set (to a synthetic is_bot user),
    // the author chip / feed show the bot, while `user_id` stays the human host
    // that actually runs and bills the session. Absent = render as user_id.
    acting_user_id: v.optional(v.id("users")),
    // Back-link to the owning anchors row when this conversation IS an anchor's
    // standing session (vs an ephemeral hand it spawned).
    anchor_id: v.optional(v.id("anchors")),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    // Sparse in practice (only banner-parked conversations are true) — lets the
    // stale-flag sweep find expired pending_api_error rows without a table scan.
    .index("by_pending_api_error", ["pending_api_error", "updated_at"])
    .index("by_user_git_root", ["user_id", "git_root"])
    .index("by_user_git_remote_url", ["user_id", "git_remote_url"])
    .index("by_user_project_path", ["user_id", "project_path"])
    .index("by_user_favorite", ["user_id", "is_favorite"])
    .index("by_user_private", ["user_id", "is_private"])
    .index("by_team_id", ["team_id"])
    .index("by_team_user_updated", ["team_id", "user_id", "updated_at"])
    // Sparse: only second-party-owned sessions carry owner_user_id. Powers the
    // owner's inbox merge (computeInboxSessions) and feed --mine.
    .index("by_owner_updated", ["owner_user_id", "updated_at"])
    .index("by_share_token", ["share_token"])
    .index("by_session_id", ["session_id"])
    .index("by_short_id", ["short_id"])
    .index("by_forked_from", ["forked_from"])
    .index("by_git_branch", ["git_branch"])
    .index("by_parent_conversation_id", ["parent_conversation_id"])
    .index("by_user_pinned", ["user_id", "inbox_pinned_at"])
    .index("by_user_stashed", ["user_id", "inbox_stashed_at"])
    .index("by_user_profile_pinned", ["user_id", "profile_pinned_at"])
    .index("by_user_dismissed", ["user_id", "inbox_dismissed_at"])
    .index("by_owner_device", ["user_id", "owner_device_id"])
    .index("by_restored_from", ["restored_from_conversation_id"])
    // `persistent` and `anchor_id` are plain fields with no index: anchors
    // resolve their conversation via anchors.conversation_id, and no query
    // scans conversations by either field. Indexes on written-to tables are
    // not free (each one adds rows to the backing `indexes` table and
    // tombstone cost on every delete) — don't add indexes speculatively.
    // Sparse: only spawned schedule runs carry agent_task_id. Powers the run
    // history strip (agentTasks.webListRuns) — every run of one schedule.
    .index("by_agent_task", ["agent_task_id"])
    .searchIndex("search_title_v2", {
      searchField: "title",
      filterFields: ["user_id"],
    })
    // Summaries are searched alongside titles (searchConversations): subtitle is
    // the generated multi-line session summary, idle_summary the one-line blurb.
    .searchIndex("search_subtitle", {
      searchField: "subtitle",
      filterFields: ["user_id"],
    })
    .searchIndex("search_idle_summary", {
      searchField: "idle_summary",
      filterFields: ["user_id"],
    }),

  // ── Anchors ─────────────────────────────────────────────────────────────────
  // A standing agent member: one per team (shared) and one per user (personal).
  // The anchor owns a long-lived `conversation_id` (persistent, pinned, rendered
  // under `bot_user_id`'s identity) that is woken by events and delegates code
  // work to ephemeral `cast spawn` hands. `host_user_id` is the human whose
  // daemon actually runs and bills the session; `bot_user_id` is identity only.
  anchors: defineTable({
    scope_type: v.union(v.literal("team"), v.literal("user")),
    // Exactly one of these is set, matching scope_type.
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")), // the human a personal anchor belongs to
    bot_user_id: v.id("users"), // the synthetic is_bot identity it renders as
    host_user_id: v.id("users"), // the human whose daemon runs + bills the session
    conversation_id: v.optional(v.id("conversations")), // the persistent session (once started)
    name: v.string(), // display name (default "Anchor", or custom)
    persona: v.optional(v.string()), // skill name or inline persona reference
    project_path: v.optional(v.string()), // cwd for the anchor and its hands
    model: v.optional(v.string()),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("decommissioned"),
    ),
    // Per-anchor governance: cap daily spawned-hand/session count; absent = default.
    daily_session_cap: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_bot_user", ["bot_user_id"])
    .index("by_host_user", ["host_user_id"])
    .index("by_conversation", ["conversation_id"]),

  // Maps an external comms channel (e.g. a Slack channel) to the anchor that
  // answers there, plus the credentials/config to post back as the bot. Kept
  // separate from `anchors` so one anchor can own several channels and so the
  // Slack adapter can resolve channel → anchor with a single indexed lookup.
  anchor_channels: defineTable({
    anchor_id: v.id("anchors"),
    surface: v.union(v.literal("slack")),
    // Slack: the channel id (e.g. "C0123"). Unique per surface.
    channel_key: v.string(),
    // Slack workspace/team id, for multi-workspace installs.
    workspace_key: v.optional(v.string()),
    project_path: v.optional(v.string()), // override the anchor's cwd for this channel
    created_at: v.number(),
  })
    .index("by_anchor", ["anchor_id"])
    .index("by_surface_channel", ["surface", "channel_key"])
    // Channel ids are only unique WITHIN a workspace, so multi-workspace routing
    // resolves on (surface, workspace, channel).
    .index("by_workspace_channel", ["surface", "workspace_key", "channel_key"]),

  // A Slack workspace connected via the "Add to Slack" OAuth flow. Holds the
  // per-workspace bot token (replaces the single app-level SLACK_BOT_TOKEN env
  // var) so many workspaces can install the one codecast Slack app. Bound to the
  // codecast scope (team or user) that authorized it, which is how link/post
  // authorize and how inbound events resolve the right token.
  slack_installations: defineTable({
    workspace_id: v.string(), // Slack team.id
    workspace_name: v.optional(v.string()),
    bot_user_id: v.string(), // Slack bot user id (self-loop detection)
    bot_token: v.string(), // xoxb- per-workspace OAuth token
    scopes: v.optional(v.string()),
    app_id: v.optional(v.string()),
    // The codecast scope that owns this install (exactly one set).
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    installed_by_user_id: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"]),

  // Idempotency for inbound Slack events: Slack retries on slow/failed acks, and
  // a double-wake would make the anchor answer the same mention twice (Aivery's
  // triple-send bug). We record each event_id and drop repeats.
  slack_events: defineTable({
    event_id: v.string(),
    created_at: v.number(),
  })
    .index("by_event_id", ["event_id"])
    .index("by_created_at", ["created_at"]),

  // Large git-diff blobs split off the conversations hot doc. The conversations
  // row is read+patched on every message sync (addMessages) and returned by list
  // queries; keeping multi-MB diffs there inflated every read/write and worsened
  // OCC contention. These are written once at session creation (and on fork) and
  // read only on-demand by getConversationGitDiff.
  conversation_git_diffs: defineTable({
    conversation_id: v.id("conversations"),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  public_conversations: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    preview_text: v.string(),
    agent_type: v.string(),
    message_count: v.number(),
    created_at: v.number(),
    view_count: v.number(),
  })
    .index("by_created_at", ["created_at"]),

  messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.optional(v.id("users")),
    message_uuid: v.optional(v.string()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
    encrypted_content: v.optional(v.string()),
    is_encrypted: v.optional(v.boolean()),
    thinking: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.object({
      id: v.string(),
      name: v.string(),
      input: v.string(),
    }))),
    tool_results: v.optional(v.array(v.object({
      tool_use_id: v.string(),
      content: v.string(),
      is_error: v.optional(v.boolean()),
    }))),
    images: v.optional(v.array(v.object({
      media_type: v.string(),
      data: v.optional(v.string()),
      storage_id: v.optional(v.id("_storage")),
      tool_use_id: v.optional(v.string()),
    }))),
    subtype: v.optional(v.string()),
    client_id: v.optional(v.string()),
    // Model that generated this assistant turn (from the agent transcript),
    // e.g. "claude-opus-4-8". Conversations can switch models mid-stream, so
    // this is per-message; conversations.model is only the last-known value.
    model: v.optional(v.string()),
    timestamp: v.number(),
    tokens_used: v.optional(v.number()),
    usage: v.optional(v.object({
      input_tokens: v.number(),
      output_tokens: v.number(),
      cache_creation_input_tokens: v.optional(v.number()),
      cache_read_input_tokens: v.optional(v.number()),
    })),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_timestamp", ["conversation_id", "timestamp"])
    .index("by_conversation_uuid", ["conversation_id", "message_uuid"])
    .index("by_message_uuid", ["message_uuid"])
    .index("by_timestamp", ["timestamp"])
    .index("by_conversation_role_timestamp", ["conversation_id", "role", "timestamp"])
    .searchIndex("search_content_v2", {
      searchField: "content",
      filterFields: ["conversation_id"],
    }),

  // Recent-window mirror of message text for content search (see
  // searchMirror.ts). search_content_v2 above scans its whole posting list per
  // term across every message ever written, so common tokens exceed the query
  // budget; this table holds only the trailing window, making the scan small
  // by construction. Rows are written solely by the searchMirror cron walker.
  message_search_recent: defineTable({
    message_id: v.id("messages"),
    conversation_id: v.id("conversations"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.string(),
    timestamp: v.number(),
    tool_calls_count: v.optional(v.number()),
    tool_results_count: v.optional(v.number()),
    // _creationTime of the SOURCE message — the window/GC axis. Distinct from
    // `timestamp` (client event time): imported old transcripts get fresh
    // creation times and should be searchable, not instantly GC'd.
    source_created_at: v.number(),
  })
    .index("by_message_id", ["message_id"])
    .index("by_source_created_at", ["source_created_at"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["conversation_id"],
    }),

  // Single row: the searchMirror walker's watermark. `cursor` = _creationTime
  // of the last mirrored message. Patched EVERY cron tick — nothing that a
  // subscribed query reads may live here (reactivity: reading this row would
  // re-run every open search each tick).
  search_mirror_state: defineTable({
    cursor: v.number(),
    updated_at: v.number(),
  }),

  // Single row, read by fetchMessageSearchPool: is the mirror serveable? The
  // walker writes it ONLY when liveness transitions (with hysteresis), so open
  // search subscriptions stay stable across cron ticks.
  search_mirror_live: defineTable({
    live: v.boolean(),
  }),

  // Story & Summary densities. Both are chunked first-person retellings cached
  // as JSON. `story` is an array of beats (each spans several turns); `summary`
  // is a coarser array of phases built by grouping the beats. Each level tracks
  // the message_count it was built at so the client knows when to regenerate.
  // Kept out of the conversations table so list queries don't carry the markdown.
  conversation_summaries: defineTable({
    conversation_id: v.id("conversations"),
    story: v.optional(v.string()),
    summary: v.optional(v.string()),
    story_message_count: v.optional(v.number()),
    summary_message_count: v.optional(v.number()),
    // Legacy field from the first (per-conversation single-summary) design.
    // Tolerated so old rows validate; superseded by the per-level counts above.
    message_count: v.optional(v.number()),
    generated_at: v.number(),
    model: v.optional(v.string()),
  }).index("by_conversation_id", ["conversation_id"]),

  bookmarks: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"])
    .index("by_message_id", ["message_id"])
    .index("by_user_name", ["user_id", "name"]),

  // Manual session buckets: personal, lightweight named groups for organizing
  // inbox sessions by workstream. Purely attention-organization for the human —
  // orthogonal to plans (which carry agent-facing context). Archive = archived_at
  // set; rows are never hard-deleted so the delta sync cache converges.
  inbox_buckets: defineTable({
    user_id: v.id("users"),
    name: v.string(),
    color: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    archived_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // One row per (user, conversation): exclusive bucket membership. Unassign sets
  // bucket_id null (delta-friendly tombstone) rather than deleting the row, so
  // every change reaches clients as an upsert. Kept off the conversation row on
  // purpose: conversations are hot, shared docs; filing is per-user and cold.
  bucket_assignments: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    bucket_id: v.optional(v.id("inbox_buckets")),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"]),

  decisions: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
    title: v.string(),
    rationale: v.string(),
    alternatives: v.optional(v.array(v.string())),
    session_id: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    message_index: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_project", ["user_id", "project_path"])
    .index("by_team_id", ["team_id"])
    .searchIndex("search_decisions_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_path"],
    }),

  patterns: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    description: v.string(),
    content: v.string(),
    source_session_id: v.optional(v.string()),
    source_conversation_id: v.optional(v.id("conversations")),
    source_range: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    usage_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_name", ["user_id", "name"])
    .index("by_team_id", ["team_id"])
    .searchIndex("search_patterns_v2", {
      searchField: "name",
      filterFields: ["user_id"],
    }),

  file_touches: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    file_path: v.string(),
    operation: v.union(
      v.literal("read"),
      v.literal("edit"),
      v.literal("write"),
      v.literal("delete"),
      v.literal("glob"),
      v.literal("grep")
    ),
    line_range: v.optional(v.string()),
    message_index: v.number(),
    timestamp: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_user_file", ["user_id", "file_path"])
    .index("by_timestamp", ["timestamp"]),

  comments: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("comments")),
    created_at: v.number(),
    github_comment_id: v.optional(v.number()),
    pr_id: v.optional(v.id("pull_requests")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    // Agent-reply comments: an opt-in "ask the agent to reply" spawns a hidden
    // fork whose answer is mirrored back into this comment. author_kind="agent"
    // renders it as the agent; agent_status tracks the reply lifecycle; the fork
    // it came from is recorded for traceability.
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    agent_status: v.optional(v.union(
      v.literal("thinking"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error"),
    )),
    fork_conversation_id: v.optional(v.id("conversations")),
    // Client-generated id for the optimistic store flow: the inboxStore stub
    // carries it as altKey so the synced server row supersedes the stub, and the
    // server dedups on it so a dispatch-outbox retry can't double-insert.
    client_id: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_message_id", ["message_id"])
    .index("by_user_id", ["user_id"])
    .index("by_parent_comment_id", ["parent_comment_id"])
    .index("by_pr_id", ["pr_id"])
    .index("by_github_comment_id", ["github_comment_id"]),

  public_comments: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("public_comments")),
    created_at: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"]),

  sync_cursors: defineTable({
    user_id: v.id("users"),
    file_path_hash: v.string(),
    last_position: v.number(),
    last_synced_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_file_path_hash", ["file_path_hash"]),

  rate_limits: defineTable({
    user_id: v.id("users"),
    endpoint: v.string(),
    window_start: v.number(),
    request_count: v.number(),
  })
    .index("by_user_endpoint", ["user_id", "endpoint"]),

  api_tokens: defineTable({
    user_id: v.id("users"),
    token_hash: v.string(),
    name: v.string(),
    created_at: v.number(),
    last_used_at: v.number(),
    expires_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_token_hash", ["token_hash"]),

  // Server-relayed `cast auth` handoffs for CLIs the browser can't reach over
  // 127.0.0.1 (SSH / remote machines). The web page deposits the minted token
  // keyed by a hash of the CLI's one-time nonce; the CLI polls /cli/claim-auth
  // and the row is deleted on first claim. Rows are transient: claimed within
  // minutes or swept (token revoked) by the cleanup cron.
  cli_auth_requests: defineTable({
    nonce_hash: v.string(),
    user_id: v.id("users"),
    token: v.string(),
    device_name: v.string(),
    created_at: v.number(),
  })
    .index("by_nonce_hash", ["nonce_hash"])
    .index("by_created_at", ["created_at"]),

  pending_messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.id("users"),
    // The user who OWNS the target conversation — i.e. whose daemon delivers this message.
    // For a self-send (the common case) this equals from_user_id; for a team send (one user
    // messaging a teammate's session) it's the teammate. Delivery, claiming, and status writes
    // route on owner; cancel/retry/status-read and failure notifications route on the sender.
    // Optional only for backward compat with rows created before this field existed (backfilled
    // to from_user_id, which they're equal to); enqueuePendingMessage always sets it on new rows.
    owner_user_id: v.optional(v.id("users")),
    // The sender's own conversation, captured so the cron can tell the sending session when a
    // cross-user message can't be delivered (the "remote not responding" feedback path).
    from_conversation_id: v.optional(v.id("conversations")),
    // Set once when the sender has been told this cross-user message is stuck — keeps the cron
    // from notifying repeatedly.
    sender_notified_at: v.optional(v.number()),
    content: v.string(),
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
    // Who initiated the send. Absent = a person (web composer, cast send, team
    // send) — those clear dismissed/stashed/killed so the session resurfaces.
    // "scheduler" = the daemon's task scheduler firing a `cast schedule`
    // injection: a machine wake must not override the user's stash (stash =
    // "keep working out of my sight"), so enqueue skips the stash-clear.
    origin: v.optional(v.literal("scheduler")),
    status: v.union(
      v.literal("pending"),
      v.literal("injected"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable"),
      // User-initiated terminal state. The only way to stop the always-on retry loop short of
      // delivery — the daemon's getPendingMessages never returns it and the healer never revives it.
      v.literal("cancelled")
    ),
    created_at: v.number(),
    delivered_at: v.optional(v.number()),
    retry_count: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_user_status", ["from_user_id", "status"])
    // The daemon polls by the TARGET owner (owner_user_id), not the sender, so a teammate's
    // message lands in the right daemon's queue. Replaces by_user_status for delivery routing.
    .index("by_owner_status", ["owner_user_id", "status"])
    // Lets the global retryStuckMessages cron read ONLY the handful of non-terminal
    // rows instead of `.filter()`-scanning the entire table (which read-conflicts
    // with every addMessages pending-write → OCC stampede → 60s sync timeouts).
    .index("by_status", ["status"]),

  // One row per machine the user runs a codecast daemon on. The remote Mac is
  // just another device. device_id is a stable hash of ~/.codecast/.machine_key,
  // bound to the machine's hardware UUID so a disk-copied ~/.codecast (Migration
  // Assistant) mints a fresh id instead of impersonating the source machine
  // (see remote/device.ts). Per-device fields (local_project_roots) live here
  // rather than on the user doc, so multiple machines don't clobber each other.
  devices: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    label: v.string(),
    platform: v.string(),
    last_seen: v.number(),
    status: v.optional(v.union(v.literal("online"), v.literal("offline"))),
    is_remote: v.optional(v.boolean()),
    local_project_roots: v.optional(v.array(v.string())),
    // Saved CC account profiles on this machine (names/emails/tiers only,
    // never tokens) — heartbeat-reported, drives the web account switcher.
    cc_accounts: v.optional(ccAccountsValidator),
    // Installed agent-feature snippets (by slug) + stable mode on this machine
    // — heartbeat-reported, drives the web Settings page (per-device toggles).
    settings: v.optional(deviceSettingsValidator),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_device", ["user_id", "device_id"]),

  managed_sessions: defineTable({
    session_id: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    user_id: v.id("users"),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    started_at: v.number(),
    last_heartbeat: v.number(),
    agent_status: v.optional(agentStatusFieldValidator),
    agent_status_updated_at: v.optional(v.number()),
    permission_mode: v.optional(v.union(v.literal("default"), v.literal("plan"), v.literal("acceptEdits"), v.literal("bypassPermissions"), v.literal("dontAsk"), v.literal("auto"))),
    current_cpu: v.optional(v.number()),
    current_memory: v.optional(v.number()),
    current_pid_count: v.optional(v.number()),
    // Real PID of the agent's process tree root (distinct from the daemon's PID
    // historically stored in `pid`). Set by the resource collector.
    agent_pid: v.optional(v.number()),
    // Accumulated time the session has been idle while the machine was AWAKE
    // (sleep gaps excluded). Reset to 0 whenever the session shows activity.
    awake_idle_ms: v.optional(v.number()),
    // When the daemon last reported live metrics for this session. Freshness
    // here is the liveness signal: a live process tree is what produces a report.
    last_metrics_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_user_heartbeat", ["user_id", "last_heartbeat"])
    .index("by_heartbeat", ["last_heartbeat"]),

  session_metrics: defineTable({
    session_id: v.string(),
    user_id: v.id("users"),
    cpu: v.number(),
    memory: v.number(),
    pid_count: v.number(),
    collected_at: v.number(),
  })
    .index("by_session_collected", ["session_id", "collected_at"])
    .index("by_user_collected", ["user_id", "collected_at"]),

  commits: defineTable({
    conversation_id: v.optional(v.id("conversations")),
    sha: v.string(),
    message: v.string(),
    author_name: v.string(),
    author_email: v.string(),
    timestamp: v.number(),
    files_changed: v.number(),
    insertions: v.number(),
    deletions: v.number(),
    repository: v.optional(v.string()),
    pr_number: v.optional(v.number()),
    files: v.optional(v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    }))),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sha", ["sha"])
    .index("by_repository", ["repository"]),

  // Per-edit file changes materialized at message ingest (materializeFileChanges
  // in messages.ts). Lets the diff viewer show the full session diff without
  // paginating the whole conversation to the top. change_key = the extractor's
  // stable per-edit id (toolCallId, or `${toolCallId}:${section}`) so re-synced
  // messages upsert idempotently instead of duplicating rows.
  file_changes: defineTable({
    conversation_id: v.id("conversations"),
    change_key: v.string(),
    message_id: v.id("messages"),
    tool_call_id: v.optional(v.string()),
    seq: v.number(),
    file_path: v.string(),
    change_type: v.union(v.literal("write"), v.literal("edit"), v.literal("commit")),
    old_content: v.optional(v.string()),
    new_content: v.string(),
    commit_message: v.optional(v.string()),
    commit_hash: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_change_key", ["conversation_id", "change_key"])
    // cast blame: resolve a git SHA to the session that committed it. Stored
    // hashes are short (parsed from `[branch abc1234]` output), so lookups
    // range-scan [sha7, fullSha] and prefix-verify.
    .index("by_commit_hash", ["commit_hash"])
    // cast blame fallback: sessions often commit via compound commands whose
    // output carries no `[branch hash]` line, so the row has a message but no
    // hash. Blame then matches commit rows by subject + timestamp proximity.
    .index("by_type_timestamp", ["change_type", "timestamp"])
    // cast blame: attribute uncommitted lines to the newest edit of the file.
    .index("by_file_path", ["file_path"]),

  pull_requests: defineTable({
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    author_github_username: v.string(),
    head_ref: v.optional(v.string()),
    base_ref: v.optional(v.string()),
    linked_session_ids: v.array(v.id("conversations")),
    pr_comment_posted: v.optional(v.boolean()),
    files: v.optional(v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    }))),
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    changed_files: v.optional(v.number()),
    commits_count: v.optional(v.number()),
    files_synced_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
  })
    .index("by_team_id", ["team_id"])
    .index("by_github_pr_id", ["github_pr_id"])
    .index("by_repository", ["repository"])
    .index("by_updated_at", ["updated_at"]),

  reviews: defineTable({
    pull_request_id: v.id("pull_requests"),
    reviewer_user_id: v.id("users"),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("commented")
    ),
    body: v.optional(v.string()),
    submitted_at: v.number(),
  })
    .index("by_pull_request", ["pull_request_id"])
    .index("by_reviewer", ["reviewer_user_id"])
    .index("by_pull_request_state", ["pull_request_id", "state"]),

  review_comments: defineTable({
    review_id: v.optional(v.id("reviews")),
    pull_request_id: v.id("pull_requests"),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    content: v.string(),
    resolved: v.boolean(),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    github_comment_id: v.optional(v.number()),
    codecast_origin: v.optional(v.boolean()),
    author_github_username: v.optional(v.string()),
    author_user_id: v.optional(v.id("users")),
  })
    .index("by_review", ["review_id"])
    .index("by_review_resolved", ["review_id", "resolved"])
    .index("by_pull_request", ["pull_request_id"])
    .index("by_github_comment_id", ["github_comment_id"]),

  team_activity_events: defineTable({
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    event_type: v.union(
      v.literal("session_started"),
      v.literal("session_completed"),
      v.literal("commit_pushed"),
      v.literal("member_joined"),
      v.literal("member_left"),
      v.literal("pr_created"),
      v.literal("pr_merged")
    ),
    title: v.string(),
    description: v.optional(v.string()),
    timestamp: v.number(),
    related_conversation_id: v.optional(v.id("conversations")),
    related_commit_sha: v.optional(v.string()),
    related_pr_id: v.optional(v.id("pull_requests")),
    metadata: v.optional(v.object({
      duration_ms: v.optional(v.number()),
      message_count: v.optional(v.number()),
      git_branch: v.optional(v.string()),
      files_changed: v.optional(v.number()),
      insertions: v.optional(v.number()),
      deletions: v.optional(v.number()),
    })),
  })
    .index("by_team_id", ["team_id"])
    .index("by_team_timestamp", ["team_id", "timestamp"])
    .index("by_actor", ["actor_user_id"]),

  session_insights: defineTable({
    conversation_id: v.id("conversations"),
    team_id: v.optional(v.id("teams")),
    actor_user_id: v.id("users"),
    source: v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic")
    ),
    generated_at: v.number(),
    summary: v.string(),
    headline: v.optional(v.string()),
    key_changes: v.optional(v.array(v.string())),
    timeline: v.optional(v.array(v.object({
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_title: v.optional(v.string()),
    }))),
    turns: v.optional(v.array(v.object({
      ask: v.string(),
      did: v.array(v.string()),
    }))),
    goal: v.optional(v.string()),
    what_changed: v.optional(v.string()),
    outcome_type: v.union(
      v.literal("shipped"),
      v.literal("progress"),
      v.literal("blocked"),
      v.literal("unknown")
    ),
    blockers: v.optional(v.array(v.string())),
    next_action: v.optional(v.string()),
    themes: v.array(v.string()),
    confidence: v.optional(v.number()),
    metadata: v.optional(v.object({
      commit_shas: v.optional(v.array(v.string())),
      pr_numbers: v.optional(v.array(v.number())),
      files_touched: v.optional(v.array(v.string())),
    })),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_team_generated_at", ["team_id", "generated_at"])
    .index("by_actor_generated_at", ["actor_user_id", "generated_at"]),

  day_timelines: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    date: v.string(),
    events: v.array(v.object({
      time: v.number(),
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_id: v.optional(v.id("conversations")),
      session_title: v.optional(v.string()),
      project: v.optional(v.string()),
    })),
    narrative: v.optional(v.string()),
    generated_at: v.number(),
  })
    .index("by_user_date", ["user_id", "date"])
    .index("by_team_date", ["team_id", "date"]),

  digests: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    date: v.string(),
    narrative: v.string(),
    events: v.array(v.object({
      time: v.number(),
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_id: v.optional(v.id("conversations")),
      session_title: v.optional(v.string()),
      project: v.optional(v.string()),
    })),
    session_count: v.optional(v.number()),
    generated_at: v.number(),
  })
    .index("by_user_scope_date", ["user_id", "scope", "date"])
    .index("by_team_scope_date", ["team_id", "scope", "date"]),

  notifications: defineTable({
    recipient_user_id: v.id("users"),
    type: v.union(
      v.literal("mention"),
      v.literal("comment_reply"),
      v.literal("conversation_comment"),
      v.literal("team_invite"),
      v.literal("session_idle"),
      v.literal("permission_request"),
      v.literal("session_error"),
      v.literal("team_session_start"),
      v.literal("task_completed"),
      v.literal("task_failed"),
      v.literal("task_assigned"),
      v.literal("task_status_changed"),
      v.literal("task_commented"),
      v.literal("doc_updated"),
      v.literal("doc_commented"),
      v.literal("plan_status_changed"),
      v.literal("plan_task_completed")
    ),
    actor_user_id: v.optional(v.id("users")),
    comment_id: v.optional(v.id("comments")),
    conversation_id: v.optional(v.id("conversations")),
    entity_type: v.optional(v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation")
    )),
    entity_id: v.optional(v.string()),
    message: v.string(),
    read: v.boolean(),
    created_at: v.number(),
  })
    .index("by_recipient", ["recipient_user_id"])
    .index("by_recipient_read", ["recipient_user_id", "read"])
    .index("by_recipient_created", ["recipient_user_id", "created_at"]),

  // Fixed-window counters for the IP-keyed rate limiter (ipRateLimit.ts) used on
  // UNAUTHENTICATED endpoints (the auth relay, webhooks) — the existing per-user
  // rate_limits table can't cover them (no userId). Keyed per (endpoint, ip) so
  // counters distribute — no hot doc. Pruned hourly.
  ip_rate_limits: defineTable({
    key: v.string(),
    count: v.number(),
    window_start: v.number(),
  }).index("by_key", ["key"]),

  pending_permissions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    tool_name: v.string(),
    arguments_preview: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("cancelled")
    ),
    created_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Denormalized conversation owner so getAllRespondedPermissions can index by
    // (owner, resolved_at) instead of scanning the whole table — the scan made
    // that live per-daemon subscription re-run on every other user's writes.
    owner_user_id: v.optional(v.id("users")),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_session", ["session_id"])
    .index("by_owner_resolved", ["owner_user_id", "resolved_at"]),

  // A signed-in link recipient (someone who opened a shared conversation but is
  // neither its owner nor a team member) asking to do more than read: to send
  // messages into the live session — which, since the agent runs whatever it's
  // told, means running commands on the owner's machine. The owner approves once
  // per session; the grant then lets performSessionSend accept that user's sends.
  // Co-writing the draft needs no grant — only firing it into the session does.
  collab_grants: defineTable({
    conversation_id: v.id("conversations"),
    grantee_user_id: v.id("users"),
    // The conversation owner whose session is acted on — the one who must approve.
    owner_user_id: v.id("users"),
    status: v.union(
      v.literal("requested"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("revoked")
    ),
    // Snapshot of the requester so the approve/deny card renders without a join.
    grantee_name: v.optional(v.string()),
    grantee_image: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_conversation_grantee", ["conversation_id", "grantee_user_id"])
    .index("by_owner_status", ["owner_user_id", "status"]),

  github_webhook_events: defineTable({
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
    processed: v.boolean(),
    created_at: v.number(),
  })
    .index("by_delivery_id", ["delivery_id"])
    .index("by_processed", ["processed"]),

  github_app_installations: defineTable({
    team_id: v.id("teams"),
    installation_id: v.number(),
    account_login: v.string(),
    account_type: v.union(v.literal("User"), v.literal("Organization")),
    account_id: v.number(),
    repository_selection: v.union(v.literal("all"), v.literal("selected")),
    repositories: v.optional(v.array(v.object({
      id: v.number(),
      name: v.string(),
      full_name: v.string(),
    }))),
    suspended_at: v.optional(v.number()),
    installed_by_user_id: v.optional(v.id("users")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_team_id", ["team_id"])
    .index("by_installation_id", ["installation_id"])
    .index("by_account_login", ["account_login"]),

  github_installation_tokens: defineTable({
    installation_id: v.number(),
    token: v.string(),
    expires_at: v.number(),
    created_at: v.number(),
  }).index("by_installation_id", ["installation_id"]),

  message_shares: defineTable({
    share_token: v.string(),
    message_id: v.id("messages"),
    user_id: v.id("users"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    message_ids: v.optional(v.array(v.id("messages"))),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_share_token", ["share_token"])
    .index("by_message_id", ["message_id"]),

  system_config: defineTable({
    key: v.string(),
    value: v.string(),
    updated_at: v.number(),
    updated_by: v.optional(v.id("users")),
  }).index("by_key", ["key"]),

  agent_tasks: defineTable({
    user_id: v.id("users"),
    title: v.string(),
    prompt: v.string(),
    context_summary: v.optional(v.string()),
    originating_conversation_id: v.optional(v.id("conversations")),
    target_conversation_id: v.optional(v.id("conversations")),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    // Device that created the task (CLI `cast schedule add`). When set, only
    // that device's scheduler may claim it. Absent on web-created/legacy tasks,
    // which fall back to checkout-existence eligibility.
    created_device_id: v.optional(v.string()),

    schedule_type: v.union(
      v.literal("once"),
      v.literal("recurring"),
      v.literal("event")
    ),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
    })),

    mode: v.union(v.literal("propose"), v.literal("apply")),
    max_runtime_ms: v.optional(v.number()),

    status: v.union(
      v.literal("scheduled"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("failed")
    ),
    lease_holder: v.optional(v.string()),
    lease_expires_at: v.optional(v.number()),
    retry_count: v.number(),
    max_retries: v.optional(v.number()),

    last_run_at: v.optional(v.number()),
    last_run_summary: v.optional(v.string()),
    // True when the last run ended in failTaskRun. Drives the panel's outcome
    // color and gates run auto-fold: a failed previous run must stay visible in
    // the inbox (escalation), only a clean run folds when the next one starts.
    last_run_failed: v.optional(v.boolean()),
    // Agent's explicit escalation from `cast schedule complete --needs-attention`:
    // the run neither auto-folds nor collapses under the schedule's standing row —
    // it stays a real inbox card until the user triages it.
    last_run_needs_attention: v.optional(v.boolean()),
    last_run_conversation_id: v.optional(v.id("conversations")),
    // Claude session UUID of the last spawned run. The daemon assigns it up front
    // via `claude --session-id`; webList resolves it to a conversation at read time
    // (by_session_id), so spawned runs are linkable even if the run's conversation
    // hadn't synced yet at completion. Absent for --context-current runs, which
    // record last_run_conversation_id directly.
    last_run_session_uuid: v.optional(v.string()),
    run_count: v.number(),
    created_at: v.number(),
    // Haiku-generated presentation fields (agentTasks.generateDisplaySummary).
    // Most titles are just prompt.slice(0, 60) — unreadable in rows — so the
    // model distills a short name and a one-sentence gist of what each run
    // does. Regenerated when the prompt changes; display_title yields to an
    // explicit human title.
    display_title: v.optional(v.string()),
    display_summary: v.optional(v.string()),
  })
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_run_at", ["user_id", "run_at"])
    .index("by_status_run_at", ["status", "run_at"])
    .index("by_event_filter", ["status"]),

  // --- Task Layer: Projects, Tasks, Docs ---

  projects: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    short_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("planning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done")
    ),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    project_path: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_short_id", ["short_id"]),

  plans: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    project_id: v.optional(v.id("projects")),
    project_path: v.optional(v.string()),
    short_id: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("abandoned"),
    ),
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("insight"),
      v.literal("promoted"),
      v.literal("plan_mode"),
      v.literal("imported"),
    ),
    owner_id: v.optional(v.id("users")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    progress: v.optional(v.object({
      total: v.number(),
      done: v.number(),
      in_progress: v.number(),
      open: v.number(),
    })),
    progress_log: v.optional(v.array(v.object({
      timestamp: v.number(),
      entry: v.string(),
      session_id: v.optional(v.string()),
    }))),
    decision_log: v.optional(v.array(v.object({
      timestamp: v.number(),
      decision: v.string(),
      rationale: v.optional(v.string()),
      session_id: v.optional(v.string()),
    }))),
    discoveries: v.optional(v.array(v.object({
      timestamp: v.number(),
      finding: v.string(),
      session_id: v.optional(v.string()),
    }))),
    context_pointers: v.optional(v.array(v.object({
      label: v.string(),
      path_or_url: v.string(),
    }))),
    // Unified comment/entry timeline (replaces progress_log, decision_log, discoveries, context_pointers for new writes)
    entries: v.optional(v.array(v.object({
      type: v.union(
        v.literal("progress"),
        v.literal("decision"),
        v.literal("discovery"),
        v.literal("reference"),
        v.literal("blocker"),
        v.literal("note"),
      ),
      timestamp: v.number(),
      session_id: v.optional(v.string()),
      content: v.string(),
      author: v.optional(v.string()),
      rationale: v.optional(v.string()),
      path_or_url: v.optional(v.string()),
    }))),
    session_ids: v.optional(v.array(v.id("conversations"))),
    current_session_id: v.optional(v.id("conversations")),
    created_from_conversation_id: v.optional(v.id("conversations")),
    created_from_insight_id: v.optional(v.id("session_insights")),
    doc_id: v.optional(v.id("docs")),
    plan_version: v.optional(v.number()),
    drive_state: v.optional(
      v.object({
        current_round: v.number(),
        total_rounds: v.number(),
        rounds: v.array(
          v.object({
            round: v.number(),
            findings: v.array(v.string()),
            fixed: v.array(v.string()),
            deferred: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    model_stylesheet: v.optional(v.string()),
    fidelity: v.optional(v.union(
      v.literal("full"),
      v.literal("compact"),
      v.literal("summary_high"),
      v.literal("summary_medium"),
      v.literal("summary_low"),
      v.literal("truncate"),
    )),
    retro: v.optional(v.object({
      smoothness: v.string(),
      headline: v.string(),
      learnings: v.array(v.any()),
      friction_points: v.array(v.any()),
      open_items: v.array(v.any()),
      generated_at: v.number(),
    })),
    join_policy: v.optional(v.union(
      v.literal("wait_all"),
      v.literal("first_success"),
      v.literal("k_of_n"),
      v.literal("quorum"),
    )),
    join_k: v.optional(v.number()),
    orchestration_metadata: v.optional(
      v.object({
        wave_count: v.optional(v.number()),
        last_wave_at: v.optional(v.number()),
        agent_count: v.optional(v.number()),
        last_orchestrated_at: v.optional(v.number()),
      }),
    ),
    escalation_log: v.optional(
      v.array(
        v.object({
          task_id: v.optional(v.string()),
          reason: v.string(),
          created_at: v.number(),
          resolved: v.optional(v.boolean()),
        }),
      ),
    ),

    // Workflow binding
    workflow_id: v.optional(v.id("workflows")),
    workflow_run_id: v.optional(v.id("workflow_runs")),

    // Public sharing
    share_token: v.optional(v.string()),

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_share_token", ["share_token"])
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_project_id", ["project_id"])
    .index("by_current_session", ["current_session_id"])
    .index("by_doc_id", ["doc_id"]),

  tasks: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    project_id: v.optional(v.id("projects")),
    parent_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    short_id: v.string(),

    title: v.string(),
    description: v.optional(v.string()),
    task_type: v.union(
      v.literal("feature"),
      v.literal("bug"),
      v.literal("task"),
      v.literal("chore")
    ),
    status: v.union(
      v.literal("backlog"),
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
      v.literal("dropped")
    ),
    priority: v.union(
      v.literal("urgent"),
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
      v.literal("none")
    ),

    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),

    model: v.optional(v.string()),
    verify_with: v.optional(v.string()),
    max_visits: v.optional(v.number()),
    retry_target: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    condition: v.optional(v.string()),

    // Dependencies
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),

    // Session linkage
    conversation_ids: v.optional(v.array(v.id("conversations"))),
    created_from_conversation: v.optional(v.id("conversations")),
    created_from_insight: v.optional(v.id("session_insights")),
    last_session_summary: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    last_attempted_at: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    max_retries: v.optional(v.number()),

    // Origin tracking
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("insight"),
      v.literal("import"),
      v.literal("plan_mode"),
      v.literal("todo_sync"),
    ),
    confidence: v.optional(v.number()),
    promoted: v.optional(v.boolean()),
    triage_status: v.optional(v.union(
      v.literal("active"),
      v.literal("suggested"),
      v.literal("dismissed"),
    )),

    // Visibility (inherited from source conversation for mined tasks)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),

    // Drive state (iterative polish)
    drive: v.optional(v.object({
      current_round: v.number(),
      total_rounds: v.number(),
      rounds: v.array(v.object({
        round: v.number(),
        findings: v.array(v.string()),
        fixed: v.array(v.string()),
        deferred: v.optional(v.array(v.string())),
      })),
    })),

    // Structured execution (superpowers-style orchestration)
    steps: v.optional(v.array(v.object({
      title: v.string(),
      done: v.optional(v.boolean()),
      verification: v.optional(v.string()),
    }))),
    acceptance_criteria: v.optional(v.array(v.string())),
    execution_status: v.optional(v.union(
      v.literal("done"),
      v.literal("done_with_concerns"),
      v.literal("blocked"),
      v.literal("needs_context"),
    )),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
    files_changed: v.optional(v.array(v.string())),
    estimated_minutes: v.optional(v.number()),
    actual_minutes: v.optional(v.number()),
    started_at: v.optional(v.number()),
    agent_session_id: v.optional(v.string()),
    wave_number: v.optional(v.number()),
    priority_weight: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
    progress_pct: v.optional(v.number()),

    // Workflow binding
    workflow_run_id: v.optional(v.id("workflow_runs")),
    workflow_node_id: v.optional(v.string()),

    project_path: v.optional(v.string()),

    created_at: v.number(),
    updated_at: v.number(),
    closed_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_project_id", ["project_id"])
    .index("by_project_status", ["project_id", "status"])
    .index("by_parent_id", ["parent_id"])
    .index("by_short_id", ["short_id"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_team_updated", ["team_id", "updated_at"])
    .index("by_workflow_run", ["workflow_run_id"])
    .index("by_assignee_status", ["assignee", "status"])
    .index("by_assignee_updated", ["assignee", "updated_at"])
    .searchIndex("search_tasks_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_id", "status"],
    }),

  orchestration_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.union(
      v.literal("agent_spawned"),
      v.literal("agent_completed"),
      v.literal("agent_failed"),
      v.literal("agent_timeout"),
      v.literal("task_completed"),
      v.literal("task_blocked"),
      v.literal("task_needs_context"),
      v.literal("merge_succeeded"),
      v.literal("merge_failed"),
      v.literal("wave_started"),
      v.literal("drive_round_started"),
      v.literal("drive_round_completed"),
      v.literal("plan_completed"),
      v.literal("retro_generated"),
      v.literal("verification_spawned"),
    ),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_plan_id", ["plan_id", "created_at"])
    .index("by_plan_short_id", ["plan_short_id", "created_at"])
    .index("by_user_id", ["user_id", "created_at"]),

  progress_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.string(),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sequence: v.number(),
    created_at: v.number(),
  })
    .index("by_plan_short_id", ["plan_short_id", "sequence"])
    .index("by_plan_id", ["plan_id", "sequence"])
    .index("by_user_id", ["user_id", "created_at"]),

  task_comments: defineTable({
    task_id: v.id("tasks"),
    author: v.string(),
    text: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    comment_type: v.union(
      v.literal("progress"),
      v.literal("blocker"),
      v.literal("review"),
      v.literal("note")
    ),
    image_storage_ids: v.optional(v.array(v.string())),
    created_at: v.number(),
  })
    .index("by_task_id", ["task_id"]),

  task_history: defineTable({
    task_id: v.id("tasks"),
    user_id: v.optional(v.id("users")),
    actor_type: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
    action: v.string(),
    field: v.optional(v.string()),
    old_value: v.optional(v.string()),
    new_value: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  })
    .index("by_task_id", ["task_id"]),

  docs: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    title: v.string(),
    content: v.string(),
    doc_type: v.union(
      v.literal("plan"),
      v.literal("design"),
      v.literal("spec"),
      v.literal("investigation"),
      v.literal("handoff"),
      v.literal("note")
    ),

    // Hierarchy: parent doc for nesting (Notion-like pages-within-pages)
    parent_id: v.optional(v.id("docs")),
    sort_order: v.optional(v.number()),
    // Explicit doc-to-doc links (wiki-style [[links]])
    linked_doc_ids: v.optional(v.array(v.id("docs"))),

    project_id: v.optional(v.id("projects")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    conversation_id: v.optional(v.id("conversations")),
    related_conversation_ids: v.optional(v.array(v.id("conversations"))),

    source: v.union(
      v.literal("agent"),
      v.literal("human"),
      v.literal("plan_mode"),
      v.literal("file_sync"),
      v.literal("inline_extract"),
      v.literal("import")
    ),
    source_file: v.optional(v.string()),
    plan_id: v.optional(v.id("plans")),

    project_path: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),

    // Visibility (inherited from source conversation for mined docs)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),

    embedding: v.optional(v.array(v.float64())),

    cli_edited_at: v.optional(v.number()),

    // Public sharing
    share_token: v.optional(v.string()),

    // Unified comment/entry timeline (symmetric with plans and tasks)
    entries: v.optional(v.array(v.object({
      type: v.union(
        v.literal("progress"),
        v.literal("decision"),
        v.literal("discovery"),
        v.literal("reference"),
        v.literal("blocker"),
        v.literal("note"),
      ),
      timestamp: v.number(),
      session_id: v.optional(v.string()),
      content: v.string(),
      author: v.optional(v.string()),
      rationale: v.optional(v.string()),
      path_or_url: v.optional(v.string()),
    }))),

    created_at: v.number(),
    updated_at: v.number(),
    archived_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_type", ["user_id", "doc_type"])
    .index("by_parent_id", ["parent_id"])
    .index("by_project_id", ["project_id"])
    .index("by_team_id", ["team_id"])
    .index("by_source_file", ["source_file"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_share_token", ["share_token"])
    .searchIndex("search_docs_v2", {
      searchField: "title",
      filterFields: ["user_id", "doc_type", "project_id"],
    }),

  doc_snapshots: defineTable({
    id: v.string(),
    version: v.number(),
    // The full ProseMirror doc serialized as JSON. Stored gzip-compressed in
    // `content_gz` (text compresses ~5-10x) so large docs stay under Convex's
    // 1 MiB per-document limit. `content` is the legacy uncompressed form —
    // still read for rows written before compression; never written anymore.
    content: v.optional(v.string()),
    content_gz: v.optional(v.bytes()),
  }).index("id_version", ["id", "version"]),

  doc_deltas: defineTable({
    id: v.string(),
    version: v.number(),
    clientId: v.union(v.string(), v.number()),
    steps: v.array(v.string()),
  }).index("id_version", ["id", "version"]),

  doc_presence: defineTable({
    doc_id: v.string(),
    user_id: v.id("users"),
    user_name: v.string(),
    user_color: v.string(),
    cursor_pos: v.optional(v.number()),
    anchor_pos: v.optional(v.number()),
    // Live draft text for composer co-presence (doc_id "compose:<conversationId>").
    // Lets each side watch the words the other is forming without a full OT buffer.
    // Unused by the document editor, which only sends cursor/anchor positions.
    draft_text: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_doc", ["doc_id"])
    .index("by_user_doc", ["user_id", "doc_id"]),

  workflows: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    slug: v.string(),
    goal: v.optional(v.string()),
    source: v.optional(v.string()),
    nodes: v.array(v.object({
      id: v.string(),
      label: v.string(),
      shape: v.string(),
      type: v.string(),
      prompt: v.optional(v.string()),
      script: v.optional(v.string()),
      reasoning_effort: v.optional(v.string()),
      model: v.optional(v.string()),
      max_visits: v.optional(v.number()),
      max_retries: v.optional(v.number()),
      retry_target: v.optional(v.string()),
      goal_gate: v.optional(v.boolean()),
      backend: v.optional(v.string()),
    })),
    edges: v.array(v.object({
      from: v.string(),
      to: v.string(),
      label: v.optional(v.string()),
      condition: v.optional(v.string()),
    })),
    model_stylesheet: v.optional(v.string()),
    is_private: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_user_slug", ["user_id", "slug"]),

  workflow_runs: defineTable({
    user_id: v.id("users"),
    workflow_id: v.optional(v.id("workflows")),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("paused"), v.literal("completed"), v.literal("failed")),
    current_node_id: v.optional(v.string()),
    node_statuses: v.array(v.object({
      node_id: v.string(),
      status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed")),
      outcome: v.optional(v.string()),
      session_id: v.optional(v.string()),
      started_at: v.optional(v.number()),
      completed_at: v.optional(v.number()),
      // Dynamic-workflow agents carry their own label/phase/tokens (no stored graph to look them up in)
      label: v.optional(v.string()),
      phase: v.optional(v.string()),
      tokens: v.optional(v.number()),
      result_preview: v.optional(v.string()),
      // Live "what it's doing" line for a running agent (runtime's last tool-call summary)
      activity: v.optional(v.string()),
    })),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
    primary_session_id: v.optional(v.string()),
    primary_conversation_id: v.optional(v.id("conversations")),
    tmux_session: v.optional(v.string()),
    gate_prompt: v.optional(v.string()),
    gate_choices: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
      target: v.string(),
    }))),
    gate_response: v.optional(v.string()),
    fail_reason: v.optional(v.string()),
    // "routine" = our DOT-graph runs (default/legacy); "workflow" = Anthropic dynamic workflows
    run_kind: v.optional(v.union(v.literal("routine"), v.literal("workflow"))),
    external_run_id: v.optional(v.string()), // the runtime's wf_<id>; idempotent upsert key for snapshot ingest
    workflow_name: v.optional(v.string()),
    phases: v.optional(v.array(v.object({ title: v.string(), detail: v.optional(v.string()) }))),
    total_tokens: v.optional(v.number()),
    agent_count: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_workflow_id", ["workflow_id"])
    .index("by_external_run", ["external_run_id"])
    .index("by_status", ["status"]),

  client_state: defineTable({
    user_id: v.id("users"),
    current_conversation_id: v.optional(v.string()),
    show_dismissed: v.optional(v.boolean()),
    dismissed_ids: v.optional(v.array(v.string())),

    // Client preference bags — typed on the client via ClientUI/ClientLayouts/etc.
    // Using v.any() so new prefs don't require schema migrations.
    ui: v.optional(v.any()),
    layouts: v.optional(v.any()),
    dismissed: v.optional(v.any()),
    tips: v.optional(v.any()),

    drafts: v.optional(v.any()),
    tabs: v.optional(v.any()),
    activeTabId: v.optional(v.string()),

    // deprecated: kept for backward compat during migration
    sidebar_collapsed: v.optional(v.boolean()),
    zen_mode: v.optional(v.boolean()),
    layout: v.optional(v.object({
      sidebar: v.number(),
      main: v.number(),
    })),

    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"]),

  daemon_logs: defineTable({
    user_id: v.id("users"),
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    message: v.string(),
    metadata: v.optional(v.object({
      session_id: v.optional(v.string()),
      error_code: v.optional(v.string()),
      stack: v.optional(v.string()),
      command: v.optional(v.string()),
      args: v.optional(v.string()),
      error: v.optional(v.string()),
    })),
    daemon_version: v.optional(v.string()),
    platform: v.optional(v.string()),
    timestamp: v.number(),
  })
    // Deliberately the ONLY index: this is the highest-row-count table in the
    // DB (telemetry), and every index multiplies both its footprint in the
    // Convex `indexes` table and the tombstone cost of pruning it. user_id
    // lookups use this index's prefix; there is no by-level query path.
    .index("by_user_timestamp", ["user_id", "timestamp"]),

  plan_templates: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    description: v.optional(v.string()),
    goal_template: v.optional(v.string()),
    task_templates: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        task_type: v.optional(v.string()),
        priority: v.optional(v.string()),
        blocked_by_indices: v.optional(v.array(v.number())),
        estimated_minutes: v.optional(v.number()),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"]),

  entity_subscriptions: defineTable({
    user_id: v.id("users"),
    entity_type: v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation")
    ),
    entity_id: v.string(),
    reason: v.union(
      v.literal("creator"),
      v.literal("assignee"),
      v.literal("mentioned"),
      v.literal("commenter"),
      v.literal("watching")
    ),
    muted: v.boolean(),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_user", ["user_id", "entity_type"])
    .index("by_user_entity", ["user_id", "entity_type", "entity_id"]),

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  })
    .index("by_name", ["name"]),

  // Cross-entity change feed — the per-user "what changed" log that lets a
  // client returning online catch up on EVERY change (including deletes) across
  // conversations, tasks, docs and plans, without re-reading whole lists and
  // diffing. One row PER ENTITY (not per change): every write upserts the row's
  // `seq` to now, so the table is bounded by entity count, not change volume.
  // The write interceptor in functions.ts is the sole writer (see changeLog.ts).
  //  - entity_id      the entity's _id as a string (entity_type says which table)
  //  - op             "upsert" (created/changed) | "delete" (hard-deleted)
  //  - owner_user_id  the entity's user_id — owner-scope catch-up (the inbox)
  //  - team_id        the entity's team_id when shared — team-scope catch-up
  //  - seq            Date.now() at write time; the monotonic cursor clients track
  change_log: defineTable({
    entity_type: v.union(
      v.literal("conversations"),
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
    ),
    entity_id: v.string(),
    op: v.union(v.literal("upsert"), v.literal("delete")),
    owner_user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    seq: v.number(),
  })
    .index("by_entity", ["entity_id"])
    .index("by_owner_seq", ["owner_user_id", "seq"])
    .index("by_team_seq", ["team_id", "seq"]),

}, {
  // The `messages` table is in the millions of rows, and the default
  // `schemaValidation: true` re-scans every document on every `convex deploy` —
  // turning a one-field function change into a multi-minute full-table walk.
  // Disable the runtime/push-time scan: writes still flow through mutations with
  // `v.*` arg validators and the schema continues to generate the TypeScript
  // types, so the validators above remain the source of truth for shape — they
  // just aren't re-checked against the whole DB on each push.
  schemaValidation: false,
});
