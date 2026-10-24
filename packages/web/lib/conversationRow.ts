// One conversation as list surfaces (the inbox list, the activity feeds) get
// it from listConversations. Its own file so code the phone shares can name
// it without pulling in the web list component.
export type Conversation = {
  _id: string;
  user_id: string;
  title?: string;
  subtitle?: string | null;
  // Newest image in the session (server-denormalized) — feed/inbox row
  // thumbnail when the inbox_image_thumbs pref is on.
  image_preview_url?: string | null;
  first_user_message?: string;
  first_assistant_message?: string;
  message_alternates?: Array<{ role: "user" | "assistant"; content: string }>;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type?: string;
  model?: string | null;
  slug?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  message_count?: number;
  ai_message_count?: number;
  tool_call_count?: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  parent_conversation_id?: string | null;
  // Visible-child pointer (agent-team teammate → its lead). The server folds it
  // into parent_conversation_id for the link; this field only picks the label.
  spawned_by_conversation_id?: string | null;
  // The handoff pair (`cast handoff --to`): a child started from a human
  // shell has no spawned_by, so the card reads this for its parent link too.
  handed_off_from_conversation_id?: string | null;
  handed_off_from_details?: { conversation_id: string; short_id: string; title?: string | null } | null;
  parent_message_uuid?: string | null;
  is_subagent?: boolean;
  is_workflow_sub?: boolean;
  workflow_run_id?: string | null;
  parent_title?: string | null;
  children?: Conversation[];
  latest_todos?: { todos: Array<{ status: string; content: string; activeForm?: string }>; timestamp: number };
  latest_usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    contextSize: number;
    timestamp: number;
  };
  project_path?: string | null;
  git_root?: string | null;
  is_favorite?: boolean;
  fork_count?: number;
  forked_from?: string | null;
  is_private?: boolean;
  // The per-session team level ("summary" | "full"; "private" marks a hide).
  // Unset means the owner's membership level for the team applies.
  team_visibility?: string | null;
  auto_shared?: boolean;
  visibility_mode?: "full" | "detailed" | "summary" | "minimal";
  activity_summary?: string;
  author_avatar?: string | null;
  // The bot identity a role's standing session renders as; user_id stays the
  // human host that runs and bills it. Absent on ordinary sessions.
  acting_user_id?: string | null;
};
