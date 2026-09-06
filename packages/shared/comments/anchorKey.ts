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

// ── Comments on code (review_comments) ──────────────────────────────────────
//
// A code comment is anchored to a repository and a ref (a commit sha or a
// branch tip), then to a file and line, or to the commit itself. Its thread
// is every comment on that anchor. The root key reads `owner/repo@sha#anchor`:
// `#` cannot appear in a repository name or a sha, so the split is exact.

export type CodeAnchorLike = {
  file_path?: string | null;
  line_number?: number | null;
};

/** `file:<path>:<line>` | `global`. Not unique across refs. */
export function codeAnchorKey(c: CodeAnchorLike): string {
  if (c.file_path) return `file:${c.file_path}:${c.line_number ?? ""}`;
  return GLOBAL_ANCHOR_KEY;
}

/** `${repository}@${ref}#${codeAnchorKey(c)}`: the thread_reads root_key of a code comment thread. */
export function codeThreadRootKey(repository: string, ref: string, c: CodeAnchorLike): string {
  return `${repository}@${ref}#${codeAnchorKey(c)}`;
}

/** Inverse of codeThreadRootKey. */
export function parseCodeThreadRootKey(rootKey: string): {
  repository: string;
  ref: string;
  anchorKey: string;
  filePath?: string;
  lineNumber?: number;
} {
  const hash = rootKey.indexOf("#");
  const head = hash < 0 ? rootKey : rootKey.slice(0, hash);
  const anchorKey = hash < 0 ? GLOBAL_ANCHOR_KEY : rootKey.slice(hash + 1);
  const at = head.lastIndexOf("@");
  const repository = at < 0 ? head : head.slice(0, at);
  const ref = at < 0 ? "" : head.slice(at + 1);
  if (!anchorKey.startsWith("file:")) return { repository, ref, anchorKey };
  const rest = anchorKey.slice(5);
  const colon = rest.lastIndexOf(":");
  const filePath = colon < 0 ? rest : rest.slice(0, colon);
  const line = colon < 0 ? "" : rest.slice(colon + 1);
  return { repository, ref, anchorKey, filePath, lineNumber: line ? Number(line) : undefined };
}
