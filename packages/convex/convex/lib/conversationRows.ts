// The rows that belong to one conversation, for every path that deletes one
// (sessionDelete's purge, a regulated team's permanent delete). One list, so
// the paths cannot disagree about what a session owns.
import { settleTaskWaits } from "../taskWaits";

// Every table whose rows belong to one conversation, with the index leading on
// conversation_id. Docs and anchors are left alone: a doc is its author's own
// object, and an anchor is a role seat (seated sessions refuse deletion).
export const CONVERSATION_ROW_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["messages", "by_conversation_id"],
  ["message_thinking", "by_conversation_message"],
  ["message_tool_inputs", "by_conversation_message"],
  ["conversation_images", "by_conversation_id"],
  ["conversation_summaries", "by_conversation_id"],
  ["session_insights", "by_conversation_id"],
  ["side_answers", "by_conversation_user"],
  ["conversation_context", "by_conversation_id"],
  ["conversation_git_diffs", "by_conversation_id"],
  ["file_changes", "by_conversation_id"],
  ["file_change_bodies", "by_conversation_change_key"],
  ["file_touches", "by_conversation"],
  ["comments", "by_conversation_id"],
  ["public_comments", "by_conversation_id"],
  ["review_comments", "by_conversation"],
  ["composer_suggestions", "by_conversation_id"],
  ["pending_messages", "by_conversation_id"],
  ["pending_permissions", "by_conversation_status"],
  ["session_decisions", "by_conversation_status"],
  ["session_goals", "by_conversation"],
  ["session_owners", "by_conversation"],
  ["session_migrations", "by_conversation"],
  ["collab_grants", "by_conversation"],
  ["share_redemptions", "by_conversation_user"],
  ["entity_conversations", "by_conversation"],
  ["commits", "by_conversation_id"],
  ["pull_request_sessions", "by_conversation"],
  ["call_agent_feeds", "by_conversation"],
  ["call_session_links", "by_conversation"],
  ["external_events", "by_conversation_created"],
  ["delivery_attempts", "by_conversation_sequence"],
  ["execution_bindings", "by_conversation_epoch"],
  ["conversation_execution_heads", "by_conversation"],
  ["managed_sessions", "by_conversation_id"],
];

/** What deleting one of those rows does beyond the row itself. */
export async function conversationRowEffects(ctx: any, table: string, row: any): Promise<void> {
  if (table === "conversation_images" && row.storage_id) {
    await ctx.storage.delete(row.storage_id).catch(() => {});
  }
  // An open question that will never be answered fails the tasks
  // waiting on it, so their owners re-plan (task-graph.md TG2).
  if (table === "session_decisions" && row.status === "pending") {
    await settleTaskWaits(ctx, row, { status: "withdrawn" });
  }
}
