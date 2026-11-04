// Conversation comments live in review_comments (ct-70907, sd-2422). Every
// reader and writer still speaks the `comments` row shape: the conversation
// surfaces, the local-first store, notifications and the CLI all receive rows
// with `user_id`, `parent_comment_id`, `pr_id` and `github_comment_id`, as
// before. This leaf holds the pure rules for that: which review_comments rows
// are conversation comments, how one maps to the `comments` shape and back,
// and which id a comment goes by.
//
// Two kinds of row are conversation comments:
//   - a twin of a `comments` row written before the write path moved
//     (source_comment_id set). It goes by the source comment's id, the id
//     every client, notification and fork link already holds.
//   - a comment written after (origin "comment"). It goes by its own id.
// The `comments` table is history: nothing writes it any more.
//
// The pull request and GitHub id sit in source_pr_id and
// source_github_comment_id rather than pull_request_id and github_comment_id,
// so no pull request reader, GitHub webhook or mirror reaches a conversation
// comment through those indexes.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { isQuoteRow } from "./quoteRows";

/** A conversation comment's id: a `comments` id for one written before the
 *  write path moved, a review_comments id for one written after. */
export type CommentId = Id<"comments"> | Id<"review_comments">;

export const commentIdValidator = v.union(v.id("comments"), v.id("review_comments"));

/** A conversation comment in the shape every surface reads. */
export type ConversationComment = Omit<Doc<"comments">, "_id" | "parent_comment_id"> & {
  _id: CommentId;
  parent_comment_id?: CommentId;
};

/** The fields a write supplies: the comment shape without its ids. */
export type ConversationCommentValue = Omit<ConversationComment, "_id" | "_creationTime">;

type CommentMarkers = { source_comment_id?: unknown; origin?: string | null };

export function isConversationComment(row: CommentMarkers): boolean {
  return (row.source_comment_id !== undefined && row.source_comment_id !== null)
    || row.origin === "comment";
}

/** The rows of review_comments that are code comments, review notes and
 *  findings: neither a composer quote nor a conversation comment. */
export function withoutBorrowedRows<T extends CommentMarkers>(rows: T[]): T[] {
  return rows.filter((row) => !isQuoteRow(row) && !isConversationComment(row));
}

/** The id a conversation comment goes by (see the header). */
export function commentIdOf(row: Pick<Doc<"review_comments">, "_id" | "source_comment_id">): CommentId {
  return row.source_comment_id ?? row._id;
}

/**
 * One review_comments row in the `comments` shape. `commentIdOfRow` names the
 * parent by the id it goes by. Only the fields that were written are present,
 * as on a `comments` row.
 */
export function commentFromRow(
  row: Doc<"review_comments">,
  commentIdOfRow: (rowId: Id<"review_comments">) => CommentId | undefined,
): ConversationComment {
  const comment: Record<string, unknown> = {
    _id: commentIdOf(row),
    _creationTime: row._creationTime,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    user_id: row.author_user_id,
    content: row.content,
    parent_comment_id: row.parent_id ? commentIdOfRow(row.parent_id) : undefined,
    created_at: row.created_at,
    github_comment_id: row.source_github_comment_id,
    pr_id: row.source_pr_id,
    file_path: row.file_path,
    line_number: row.line_number,
    anchor_lines: row.anchor_lines,
    author_kind: row.author_kind === "github" ? undefined : row.author_kind,
    agent_status: row.agent_status,
    fork_conversation_id: row.fork_conversation_id,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    client_id: row.client_id,
  };
  for (const key of Object.keys(comment)) if (comment[key] === undefined) delete comment[key];
  return comment as ConversationComment;
}

/** Every row of one conversation's review_comments that is a comment, in the
 *  `comments` shape, unsorted. */
export function commentsFromRows(rows: Doc<"review_comments">[]): ConversationComment[] {
  const comments = rows.filter(isConversationComment);
  const idOfRow = new Map(comments.map((row) => [String(row._id), commentIdOf(row)]));
  return comments.map((row) => commentFromRow(row, (id) => idOfRow.get(String(id))));
}

// The comment fields and the review_comments field each is stored in.
const FIELD_OF: Partial<Record<keyof ConversationCommentValue, keyof Doc<"review_comments">>> = {
  conversation_id: "conversation_id",
  message_id: "message_id",
  user_id: "author_user_id",
  content: "content",
  created_at: "created_at",
  github_comment_id: "source_github_comment_id",
  pr_id: "source_pr_id",
  file_path: "file_path",
  line_number: "line_number",
  anchor_lines: "anchor_lines",
  author_kind: "author_kind",
  agent_status: "agent_status",
  fork_conversation_id: "fork_conversation_id",
  resolved_at: "resolved_at",
  resolved_by: "resolved_by",
  client_id: "client_id",
};

/**
 * A patch on the comment shape, as a patch on its review_comments row.
 * `resolved` follows `resolved_at`. The parent is not patchable: a reply stays
 * in the thread it was written in.
 */
export function rowPatchFromComment(patch: Partial<ConversationCommentValue>): Partial<Doc<"review_comments">> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "parent_comment_id") throw new Error("A comment's parent cannot change");
    const field = FIELD_OF[key as keyof ConversationCommentValue];
    if (!field) throw new Error(`Unknown comment field ${key}`);
    out[field] = value;
  }
  if ("resolved_at" in patch) out.resolved = patch.resolved_at !== undefined && patch.resolved_at !== null;
  return out as Partial<Doc<"review_comments">>;
}

/** A new comment as a review_comments row. `parentRowId` is the parent's row. */
export function rowFromComment(
  value: ConversationCommentValue,
  parentRowId: Id<"review_comments"> | undefined,
): Omit<Doc<"review_comments">, "_id" | "_creationTime"> {
  const { parent_comment_id: _parent, ...rest } = value;
  return {
    ...(rowPatchFromComment(rest) as Omit<Doc<"review_comments">, "_id" | "_creationTime">),
    origin: "comment",
    parent_id: parentRowId,
    resolved: value.resolved_at !== undefined && value.resolved_at !== null,
  };
}
