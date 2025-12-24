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
    daemon_last_seen: v.optional(v.number()),
    theme: v.optional(v.union(v.literal("dark"), v.literal("light"))),
    github_id: v.optional(v.string()),
    github_username: v.optional(v.string()),
    github_avatar_url: v.optional(v.string()),
    push_token: v.optional(v.string()),
    notifications_enabled: v.optional(v.boolean()),
    notification_preferences: v.optional(v.object({
      team_session_start: v.boolean(),
      mention: v.boolean(),
      permission_request: v.boolean(),
    })),
  }).index("email", ["email"]),

  teams: defineTable({
    name: v.string(),
    created_at: v.number(),
    invite_code: v.string(),
    invite_code_expires_at: v.optional(v.number()),
  }).index("by_invite_code", ["invite_code"]),

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
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_agent_type", ["agent_type"])
    .index("by_share_token", ["share_token"])
    .index("by_session_id", ["session_id"]),

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
      data: v.string(),
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
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_timestamp", ["conversation_id", "timestamp"])
    .index("by_conversation_uuid", ["conversation_id", "message_uuid"])
    .index("by_message_uuid", ["message_uuid"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["conversation_id"],
    }),

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
      v.literal("failed")
    ),
    created_at: v.number(),
    delivered_at: v.optional(v.number()),
    retry_count: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_status", ["from_user_id", "status"]),

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
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sha", ["sha"]),

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
    linked_session_ids: v.array(v.id("conversations")),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
  })
    .index("by_team_id", ["team_id"])
    .index("by_github_pr_id", ["github_pr_id"])
    .index("by_repository", ["repository"]),

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
    review_id: v.id("reviews"),
    file_path: v.string(),
    line_number: v.number(),
    content: v.string(),
    resolved: v.boolean(),
    created_at: v.number(),
  })
    .index("by_review", ["review_id"])
    .index("by_review_resolved", ["review_id", "resolved"]),
});
