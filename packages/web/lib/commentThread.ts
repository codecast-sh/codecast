// Client-side shapes + grouping for the conversation comment rail. The server
// stores every comment in one `comments` table; a comment is "anchored" when it
// carries a message_id and "global" when it doesn't. A thread is the set of
// comments sharing the same (conversation, message_id|null) — that's the unit a
// teammate (or the agent) chats in.

export type CommentUser = {
  _id?: string;
  name?: string | null;
  github_username?: string | null;
  github_avatar_url?: string | null;
  image?: string | null;
};

export type Comment = {
  _id: string;
  conversation_id: string;
  message_id?: string | null;
  user_id: string;
  content: string;
  parent_comment_id?: string | null;
  created_at: number;
  // tier-3 agent reply metadata (optional; absent on plain teammate comments)
  author_kind?: "user" | "agent" | null;
  agent_status?: "thinking" | "streaming" | "done" | "error" | null;
  fork_conversation_id?: string | null;
  // Client-generated id carried by the optimistic store stub; the synced server
  // row supersedes the stub via the comments altKey config.
  client_id?: string | null;
  user?: CommentUser | null;
};

export type CommentThread = {
  // stable key: "global" or the anchored message id
  key: string;
  messageId?: string;
  comments: Comment[]; // chronological (oldest → newest)
  lastActivity: number;
};

export const GLOBAL_THREAD_KEY = "global";

export function threadKeyFor(messageId?: string | null): string {
  return messageId ? messageId : GLOBAL_THREAD_KEY;
}

// doc_presence namespace for a thread's typing/co-presence channel.
export function presenceDocId(conversationId: string, messageId?: string | null): string {
  return messageId ? `comment:${conversationId}:${messageId}` : `comment:${conversationId}`;
}

// Split a flat comment list into the global thread + one thread per anchored
// message. Each thread's comments are sorted oldest→newest (chat order); threads
// keep a lastActivity for ordering the anchored list when no message order is
// available.
export function groupComments(comments: Comment[]): { global: CommentThread; anchored: CommentThread[] } {
  const byKey = new Map<string, Comment[]>();
  for (const c of comments) {
    const key = threadKeyFor(c.message_id);
    const arr = byKey.get(key);
    if (arr) arr.push(c);
    else byKey.set(key, [c]);
  }
  const make = (key: string, messageId: string | undefined, list: Comment[]): CommentThread => {
    const sorted = [...list].sort((a, b) => a.created_at - b.created_at);
    return { key, messageId, comments: sorted, lastActivity: sorted.length ? sorted[sorted.length - 1].created_at : 0 };
  };
  const global = make(GLOBAL_THREAD_KEY, undefined, byKey.get(GLOBAL_THREAD_KEY) ?? []);
  const anchored: CommentThread[] = [];
  for (const [key, list] of byKey) {
    if (key === GLOBAL_THREAD_KEY) continue;
    anchored.push(make(key, key, list));
  }
  return { global, anchored };
}

export function isAgentComment(c: Comment): boolean {
  return c.author_kind === "agent";
}

// The agent's product name (short), so a reply reads "Claude"/"Codex" — not "Agent".
export function agentDisplayName(agentType?: string): string {
  if (agentType === "codex" || agentType === "codex_cli") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  return "Claude";
}

export function commentAuthorName(c: Comment, currentUserId?: string, agentType?: string): string {
  if (isAgentComment(c)) return agentDisplayName(agentType);
  const u = c.user;
  const name = u?.name || u?.github_username || "";
  if (name) return name;
  if (currentUserId && c.user_id === currentUserId) return "You";
  return "Teammate";
}

export function commentAuthorAvatar(c: Comment): string | undefined {
  if (isAgentComment(c)) return undefined;
  return c.user?.image || c.user?.github_avatar_url || undefined;
}

export function isOwnComment(c: Comment, currentUserId?: string): boolean {
  return !!currentUserId && !isAgentComment(c) && c.user_id === currentUserId;
}
