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
    daemon_pid: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
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
      v.literal("version")
    ),
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
      v.literal("cursor")
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
    status: v.union(v.literal("active"), v.literal("completed")),
    share_token: v.optional(v.string()),
    parent_message_uuid: v.optional(v.string()),
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
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_user_favorite", ["user_id", "is_favorite"])
    .index("by_user_private", ["user_id", "is_private"])
    .index("by_team_id", ["team_id"])
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
    .index("by_parent_message_uuid", ["parent_message_uuid"]),

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
    }))),
    subtype: v.optional(v.string()),
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
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable")
    ),
    created_at: v.number(),
    delivered_at: v.optional(v.number()),
    retry_count: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_status", ["from_user_id", "status"]),

  managed_sessions: defineTable({
    session_id: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    user_id: v.id("users"),
    pid: v.number(),
    started_at: v.number(),
    last_heartbeat: v.number(),
  })
    .index("by_session_id", ["session_id"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"]),

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

  notifications: defineTable({
    recipient_user_id: v.id("users"),
    type: v.union(
      v.literal("mention"),
      v.literal("comment_reply"),
      v.literal("conversation_comment"),
      v.literal("team_invite")
    ),
    actor_user_id: v.id("users"),
    comment_id: v.optional(v.id("comments")),
    conversation_id: v.optional(v.id("conversations")),
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
    })),
    daemon_version: v.optional(v.string()),
    platform: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_timestamp", ["user_id", "timestamp"])
    .index("by_user_level", ["user_id", "level"]),
});
