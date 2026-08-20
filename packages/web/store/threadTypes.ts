// The Threads inbox's row types. One row per (viewer, thread) across every
// threaded system — chat threads, session comment threads, task comment
// streams — as threads.listMine returns them. The shape mirrors the server's
// ThreadInboxEntry (convex/threads.ts); keep the two in step.

export type ThreadKind = "chat" | "comment" | "task" | "page";

/** The newest counted reply of a thread, for the collapsed card's preview. */
export type ThreadLastReply = {
  /** chat_messages | comments | task_comments id. */
  _id: string;
  user_id?: string;
  author_kind?: "user" | "agent";
  /** Resolved display name (task comments carry only a string author). */
  author_name?: string;
  created_at: number;
  /** Plain text, at most 160 characters. */
  preview: string;
};

/** One row of threads.listMine. A derived snapshot (the raw thread_reads doc
 *  plus the server's unread numbers), synced as a delta overlay so a page of
 *  entries never prunes the rest, and patched optimistically on mark-read
 *  because its numbers reconcile by value. */
export type ThreadInboxRow = {
  /** `${kind}:${root_key}` — see threadRowId. */
  _id: string;
  kind: ThreadKind;
  /** chat: root chat_messages id. comment: `${conversation_id}:${anchorKey}`.
   *  task: task id. page: artifact id. */
  root_key: string;
  /** The entity's routing team; absent in the personal workspace. */
  team_id?: string;
  channel_id?: string;
  conversation_id?: string;
  task_id?: string;
  artifact_id?: string;
  message_id?: string;
  file_path?: string;
  line_number?: number;
  last_activity_at: number;
  last_read_at: number;
  updated_at: number;
  unread: number;
  unread_capped?: boolean;
  last_reply?: ThreadLastReply | null;
};

/** One comment of a published page's discussion, as threads.listMine ships it
 *  (convex/threads.ts PageComment: the artifact_comments row minus the
 *  commenter's email). Optimistic stubs use a `pagecmtstub-` _id and carry a
 *  client_id the server row echoes, so the synced row supersedes the stub. */
export type PageCommentRow = {
  _id: string;
  artifact_id: string;
  author_name: string;
  author_user_id?: string;
  author_avatar?: string;
  parent_comment_id?: string;
  client_id?: string;
  text: string;
  anchor?: string;
  version: number;
  status: string; // "open" | "resolved"
  created_at: number;
};

/** The slice of a published page a Threads card needs, with its newest
 *  comments embedded (convex/threads.ts PageThreadEntity). Keyed by the
 *  artifact id — the page kind's root_key. */
export type PageThreadRow = {
  _id: string;
  slug: string;
  title: string;
  kind?: string;
  user_id: string;
  updated_at: number;
  comments: PageCommentRow[];
};

/** The store key of a thread row. */
export function threadRowId(kind: ThreadKind, rootKey: string): string {
  return `${kind}:${rootKey}`;
}
