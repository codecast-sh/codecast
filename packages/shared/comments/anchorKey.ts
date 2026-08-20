// The identity of a comment thread, shared by the server (thread_reads root
// keys, comments.ts grouping) and the web (lib/commentThread.ts). A thread is
// the set of comments on one anchor: a message, a code line, or the
// conversation itself. Two implementations of this key would drift, and the
// drift would show up as a thread that is read on one surface and unread on
// the other.

export type CommentAnchorLike = {
  message_id?: unknown;
  file_path?: string | null;
  line_number?: number | null;
};

export const GLOBAL_ANCHOR_KEY = "global";

/** `msg:<message_id>` | `file:<path>:<line>` | `global`. Not unique across conversations. */
export function commentAnchorKey(c: CommentAnchorLike): string {
  if (c.message_id) return `msg:${c.message_id}`;
  if (c.file_path) return `file:${c.file_path}:${c.line_number ?? ""}`;
  return GLOBAL_ANCHOR_KEY;
}

/** `${conversationId}:${commentAnchorKey(c)}`: the thread_reads root_key of a comment thread. */
export function commentThreadRootKey(conversationId: string, c: CommentAnchorLike): string {
  return `${conversationId}:${commentAnchorKey(c)}`;
}

/** Inverse of commentThreadRootKey. Splits on the FIRST ":" (conversation ids contain none). */
export function parseCommentThreadRootKey(rootKey: string): { conversationId: string; anchorKey: string } {
  const i = rootKey.indexOf(":");
  if (i < 0) return { conversationId: rootKey, anchorKey: GLOBAL_ANCHOR_KEY };
  return { conversationId: rootKey.slice(0, i), anchorKey: rootKey.slice(i + 1) };
}

/** Web thread key (lib/commentThread.ts format): `msg:<id>` becomes `<id>`; file and global stay. */
export function webThreadKeyFromAnchor(anchorKey: string): string {
  return anchorKey.startsWith("msg:") ? anchorKey.slice(4) : anchorKey;
}
