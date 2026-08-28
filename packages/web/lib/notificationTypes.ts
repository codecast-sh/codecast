// One list of notification types for every surface that renders one. The
// notifications page and the bell carried byte-identical copies of these maps
// and of the click router, which is how three chat types reached the table and
// rendered with a blank label, a default colour, no filter tab, and a click that
// fell through to the inbox.
//
// The server's list lives in convex/notificationRouter.ts; a convex test asserts
// the schema, the router and the preference map agree. This is the client half.

export const sessionTypes = new Set([
  "session_idle",
  "session_error",
  "permission_request",
]);

export const socialTypes = new Set([
  "mention",
  "comment_reply",
  "conversation_comment",
  "team_invite",
  "artifact_commented",
  "chat_mention",
  "chat_reply",
  "chat_here",
  "chat_dm",
  "chat_added",
  "chat_post",
]);

export const taskTypes = new Set([
  "task_assigned",
  "task_status_changed",
  "task_commented",
  "task_completed",
  "task_failed",
  "plan_status_changed",
  "plan_task_completed",
  "doc_updated",
  "doc_commented",
]);

export const typeLabels: Record<string, string> = {
  team_session_start: "started coding",
  session_idle: "ready",
  session_error: "error",
  permission_request: "needs permission",
  mention: "mentioned you",
  comment_reply: "replied",
  conversation_comment: "commented",
  team_invite: "team invite",
  task_completed: "task done",
  task_failed: "task failed",
  task_assigned: "assigned to you",
  task_status_changed: "status changed",
  task_commented: "commented",
  doc_updated: "doc updated",
  doc_commented: "commented on doc",
  plan_status_changed: "plan updated",
  plan_task_completed: "plan task done",
  artifact_commented: "commented on your page",
  chat_mention: "mentioned you in chat",
  chat_reply: "replied in a thread",
  chat_here: "posted to everyone here",
  chat_dm: "sent you a direct message",
  chat_added: "added you to a channel",
  chat_post: "posted in a channel you follow",
};

export const typeColors: Record<string, string> = {
  team_session_start: "text-sol-green",
  session_idle: "text-sol-green",
  session_error: "text-red-400",
  permission_request: "text-sol-orange",
  mention: "text-sol-blue",
  comment_reply: "text-sol-cyan",
  conversation_comment: "text-sol-cyan",
  team_invite: "text-sol-violet",
  task_completed: "text-sol-green",
  task_failed: "text-red-400",
  task_assigned: "text-sol-yellow",
  task_status_changed: "text-sol-yellow",
  task_commented: "text-sol-cyan",
  doc_updated: "text-sol-violet",
  doc_commented: "text-sol-cyan",
  plan_status_changed: "text-sol-green",
  plan_task_completed: "text-sol-green",
  artifact_commented: "text-sol-cyan",
  chat_mention: "text-sol-blue",
  chat_reply: "text-sol-cyan",
  chat_here: "text-sol-orange",
  chat_dm: "text-sol-orange",
  chat_added: "text-sol-cyan",
  chat_post: "text-sol-cyan",
};

export const agentNames: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  codex_cli: "codex",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
  pi: "pi",
  grok: "grok",
};

/** Display label for the session a notification belongs to: title, else project basename. */
export function sessionLabel(
  conversation: { title?: string; project_path?: string; agent_type?: string } | null | undefined,
): string | null {
  if (!conversation) return null;
  if (conversation.title) return conversation.title;
  if (conversation.project_path) {
    const parts = conversation.project_path.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || conversation.project_path;
  }
  return null;
}

/**
 * Where a notification's entity opens, given the entity it names and — for
 * chat, which addresses a position inside a page — the message it points at.
 * Returns null when the entity has no page of its own and the caller should fall
 * back to the conversation or the inbox.
 *
 * The chat shape mirrors convex/chatText.ts `chatPermalink`, so the bell, the
 * push payload and the CLI all name the same URL.
 */
export function notificationRoute(
  entityType: string | undefined,
  entityId: string | undefined,
  chatMessageId?: string,
): string | null {
  if (!entityType || !entityId) return null;
  const simple: Record<string, string> = { task: "/tasks/", doc: "/docs/", plan: "/plans/" };
  if (simple[entityType]) return `${simple[entityType]}${entityId}`;
  if (entityType === "chat_channel") {
    return chatMessageId ? `/chat/${entityId}?m=${chatMessageId}` : `/chat/${entityId}`;
  }
  return null;
}
