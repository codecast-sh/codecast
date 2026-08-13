// Client-side shapes + grouping for the conversation comment rail. The server
// stores every comment in one `comments` table; a comment is "anchored" when it
// carries a message_id, "on code" when it carries a file_path + line_number
// (a durable line comment left in a diff), and "global" when it carries neither.
// A thread is the set of comments sharing the same anchor — that's the unit a
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
  // Durable code anchor: a comment left on one line of a file in a diff.
  file_path?: string | null;
  line_number?: number | null;
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
  // stable key: "global", the anchored message id, or "file:<path>:<line>"
  key: string;
  messageId?: string;
  filePath?: string;
  lineNumber?: number;
  comments: Comment[]; // chronological (oldest → newest)
  lastActivity: number;
};

export const GLOBAL_THREAD_KEY = "global";
const FILE_THREAD_PREFIX = "file:";

export function fileThreadKey(filePath: string, lineNumber?: number | null): string {
  return `${FILE_THREAD_PREFIX}${filePath}:${lineNumber ?? ""}`;
}

export function threadKeyFor(messageId?: string | null): string {
  return messageId ? messageId : GLOBAL_THREAD_KEY;
}

// doc_presence namespace for a thread's typing/co-presence channel. `anchor` is
// the anchored message id or a file thread key; absent = the global thread.
export function presenceDocId(conversationId: string, anchor?: string | null): string {
  return anchor ? `comment:${conversationId}:${anchor}` : `comment:${conversationId}`;
}

// Split a flat comment list into the global thread + one thread per anchored
// message + one thread per commented code line. Each thread's comments are
// sorted oldest→newest (chat order); threads keep a lastActivity for ordering
// the anchored lists when no message order is available.
export function groupComments(comments: Comment[]): { global: CommentThread; anchored: CommentThread[]; files: CommentThread[] } {
  const byKey = new Map<string, Comment[]>();
  const fileAnchors = new Map<string, { filePath: string; lineNumber?: number }>();
  for (const c of comments) {
    let key: string;
    if (c.message_id) {
      key = c.message_id;
    } else if (c.file_path) {
      key = fileThreadKey(c.file_path, c.line_number);
      if (!fileAnchors.has(key)) {
        fileAnchors.set(key, { filePath: c.file_path, lineNumber: c.line_number ?? undefined });
      }
    } else {
      key = GLOBAL_THREAD_KEY;
    }
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
  const files: CommentThread[] = [];
  for (const [key, list] of byKey) {
    if (key === GLOBAL_THREAD_KEY) continue;
    const fileAnchor = fileAnchors.get(key);
    if (fileAnchor) {
      files.push({ ...make(key, undefined, list), ...fileAnchor });
    } else {
      anchored.push(make(key, key, list));
    }
  }
  return { global, anchored, files };
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
