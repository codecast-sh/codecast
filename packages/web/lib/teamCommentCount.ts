export type CommentRows = Record<string, { conversation_id?: string; message_id?: string }>;

// Comment counts by message, built once per comments collection (the store
// hands back a new object only when a comment changes) and shared by every
// row. Each row's selector runs on every store write, so it must not walk
// every comment there.
const COMMENT_COUNTS = new WeakMap<object, Map<string, number>>();

export function teamCommentCount(comments: CommentRows | undefined, conversationId: string, messageId: string): number {
  if (!comments) return 0;
  let counts = COMMENT_COUNTS.get(comments);
  if (!counts) {
    counts = new Map();
    for (const id in comments) {
      const c = comments[id];
      const key = `${c.conversation_id}\u0000${c.message_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    COMMENT_COUNTS.set(comments, counts);
  }
  return counts.get(`${conversationId}\u0000${messageId}`) ?? 0;
}
