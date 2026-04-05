import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";

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
    team_conversations_last_seen: v.optional(v.number()),
    cli_version: v.optional(v.string()),
    cli_platform: v.optional(v.string()),
    autostart_enabled: v.optional(v.boolean()),
    has_tmux: v.optional(v.boolean()),
    daemon_pid: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
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
  })
    .index("email", ["email"])
    .index("by_github_username", ["github_username"])
    .index("by_github_id", ["github_id"])
    .index("by_team_id", ["team_id"]),

  daemon_commands: defineTable({
    user_id: v.id("users"),
    command: v.union(
      v.literal("status"),
      v.literal("restart"),
      v.literal("force_update"),
      v.literal("version"),
      v.literal("start_session"),
      v.literal("escape"),
      v.literal("resume_session"),
      v.literal("kill_session"),
      v.literal("send_keys"),
      v.literal("rewind"),
      v.literal("config_list"),
      v.literal("config_read"),
      v.literal("config_write"),
      v.literal("config_create"),
      v.literal("config_delete"),
      v.literal("run_workflow")
    ),
    args: v.optional(v.string()),
    created_at: v.number(),
    executed_at: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
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
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    git_root: v.optional(v.string()),
    fork_count: v.optional(v.number()),
    forked_from: v.optional(v.id("conversations")),
    is_favorite: v.optional(v.boolean()),
    short_id: v.optional(v.string()),
    auto_shared: v.optional(v.boolean()),
    skip_title_generation: v.optional(v.boolean()),
    idle_summary: v.optional(v.string()),
    inbox_dismissed_at: v.optional(v.number()),
    inbox_killed_at: v.optional(v.number()),
    inbox_deferred_at: v.optional(v.number()),
    inbox_pinned_at: v.optional(v.number()),
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
    available_skills: v.optional(v.string()),
    subagent_description: v.optional(v.string()),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_user_subagent_updated", ["user_id", "is_subagent", "updated_at"])
    .index("by_user_favorite", ["user_id", "is_favorite"])
    .index("by_user_private", ["user_id", "is_private"])
    .index("by_team_id", ["team_id"])
    .index("by_team_user_updated", ["team_id", "user_id", "updated_at"])
    .index("by_agent_type", ["agent_type"])
    .vectorIndex("by_title_embedding", {
      vectorField: "title_embedding",
      dimensions: 1024,
      filterFields: ["user_id"],
    })
    .index("by_share_token", ["share_token"])
    .index("by_session_id", ["session_id"])
    .index("by_short_id", ["short_id"])
    .index("by_forked_from", ["forked_from"])
    .index("by_git_branch", ["git_branch"])
    .index("by_parent_message_uuid", ["parent_message_uuid"])
    .index("by_parent_conversation_id", ["parent_conversation_id"])
    .index("by_user_pinned", ["user_id", "inbox_pinned_at"])
    .index("by_user_dismissed", ["user_id", "inbox_dismissed_at"])
    .index("by_workflow_run", ["workflow_run_id"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["user_id"],
    }),

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
    .index("by_created_at", ["created_at"])
    .index("by_view_count", ["view_count"]),

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
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["conversation_id"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["conversation_id"],
    }),

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
    .searchIndex("search_decisions", {
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
    .searchIndex("search_patterns", {
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
    .index("by_file_path", ["file_path"])
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

  pending_messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.id("users"),
    content: v.string(),
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("injected"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable")
    ),
    created_at: v.number(),
    delivered_at: v.optional(v.number()),
    retry_count: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_user_status", ["from_user_id", "status"]),

  managed_sessions: defineTable({
    session_id: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    user_id: v.id("users"),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    started_at: v.number(),
    last_heartbeat: v.number(),
    agent_status: v.optional(v.union(v.literal("working"), v.literal("idle"), v.literal("permission_blocked"), v.literal("compacting"), v.literal("thinking"), v.literal("connected"), v.literal("stopped"), v.literal("starting"), v.literal("resuming"))),
    agent_status_updated_at: v.optional(v.number()),
    permission_mode: v.optional(v.union(v.literal("default"), v.literal("plan"), v.literal("acceptEdits"), v.literal("bypassPermissions"), v.literal("dontAsk"))),
    current_cpu: v.optional(v.number()),
    current_memory: v.optional(v.number()),
    current_pid_count: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_user_heartbeat", ["user_id", "last_heartbeat"]),

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
    .index("by_head_ref", ["head_ref"])
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

  pending_permissions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    tool_name: v.string(),
    arguments_preview: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied")
    ),
    created_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_session", ["session_id"]),

  github_webhook_events: defineTable({
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
    processed: v.boolean(),
    created_at: v.number(),
  })
    .index("by_delivery_id", ["delivery_id"])
    .index("by_processed", ["processed"])
    .index("by_event_type", ["event_type"]),

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
    last_run_conversation_id: v.optional(v.id("conversations")),
    run_count: v.number(),
    created_at: v.number(),
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

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
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
    .index("by_project_id", ["project_id"])
    .index("by_project_status", ["project_id", "status"])
    .index("by_parent_id", ["parent_id"])
    .index("by_short_id", ["short_id"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_workflow_run", ["workflow_run_id"])
    .searchIndex("search_tasks", {
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
    .index("by_project_id", ["project_id"])
    .index("by_team_id", ["team_id"])
    .index("by_source_file", ["source_file"])
    .index("by_conversation_id", ["conversation_id"])
    .searchIndex("search_docs", {
      searchField: "title",
      filterFields: ["user_id", "doc_type", "project_id"],
    })
    .vectorIndex("by_doc_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["user_id"],
    }),

  doc_snapshots: defineTable({
    id: v.string(),
    version: v.number(),
    content: v.string(),
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
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_workflow_id", ["workflow_id"])
    .index("by_status", ["status"]),

  client_state: defineTable({
    user_id: v.id("users"),
    current_conversation_id: v.optional(v.string()),
    show_dismissed: v.optional(v.boolean()),
    dismissed_ids: v.optional(v.array(v.string())),

    ui: v.optional(v.object({
      theme: v.optional(v.union(v.literal("dark"), v.literal("light"))),
      sidebar_collapsed: v.optional(v.boolean()),
      zen_mode: v.optional(v.boolean()),
      sticky_headers_disabled: v.optional(v.boolean()),
      diff_panel_open: v.optional(v.boolean()),
      file_diff_view_mode: v.optional(v.union(v.literal("unified"), v.literal("split"))),
      active_team_id: v.optional(v.string()),
      active_filter: v.optional(v.union(v.literal("my"), v.literal("team"))),
      inbox_shortcuts_hidden: v.optional(v.boolean()),
      workspace_initialized: v.optional(v.boolean()),
      task_view: v.optional(v.object({
        status: v.optional(v.string()),
        view: v.optional(v.union(v.literal("list"), v.literal("kanban"))),
        sort: v.optional(v.string()),
        priority: v.optional(v.string()),
        label: v.optional(v.string()),
        assignee: v.optional(v.string()),
        hide_agent: v.optional(v.boolean()),
        source: v.optional(v.string()),
      })),
      doc_view: v.optional(v.object({
        doc_type: v.optional(v.string()),
      })),
    })),

    layouts: v.optional(v.object({
      dashboard: v.optional(v.object({ sidebar: v.number(), main: v.number() })),
      inbox: v.optional(v.object({ main: v.number(), sidebar: v.number() })),
      conversation_diff: v.optional(v.object({ content: v.number(), diff: v.number() })),
      file_diff: v.optional(v.object({ tree: v.number(), content: v.number() })),
    })),

    dismissed: v.optional(v.object({
      desktop_app: v.optional(v.boolean()),
      has_used_desktop: v.optional(v.boolean()),
      setup_prompt: v.optional(v.number()),
      cli_offline: v.optional(v.number()),
      tmux_missing: v.optional(v.number()),
    })),

    tips: v.optional(v.object({
      seen: v.optional(v.array(v.string())),
      dismissed: v.optional(v.array(v.string())),
      completed: v.optional(v.array(v.string())),
      level: v.optional(v.union(v.literal("all"), v.literal("subtle"), v.literal("none"))),
    })),

    drafts: v.optional(v.any()),

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
    .index("by_user_id", ["user_id"])
    .index("by_user_timestamp", ["user_id", "timestamp"])
    .index("by_user_level", ["user_id", "level"]),

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

});
