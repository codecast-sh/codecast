// A conversation comment (`comments`) and its twin in `review_comments`.
//
// While conversation comments move into review_comments, every `comments`
// write also writes a twin there (convex/commentTwins.ts), and `comments` stays
// the source of truth. This leaf holds the pure rules both sides share: how a
// comment maps onto a twin, how a twin projects back into the comment shape
// the conversation surfaces render, and which review_comments rows are twins.
//
// The twin keeps the source's pull request and GitHub id in their own fields
// (source_pr_id, source_github_comment_id) rather than pull_request_id and
// github_comment_id, so no pull request reader, GitHub webhook or mirror can
// find a twin through those indexes. The rest map onto the field of the same
// meaning.

import type { Doc, Id } from "../_generated/dataModel";
import { isQuoteRow } from "./quoteRows";

export function isCommentTwin(row: { source_comment_id?: unknown }): boolean {
  return row.source_comment_id !== undefined && row.source_comment_id !== null;
}

/** The rows of review_comments that are code comments, review notes and
 *  findings: neither a composer quote nor a conversation comment twin. */
export function withoutBorrowedRows<T extends { origin?: string | null; source_comment_id?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !isQuoteRow(row) && !isCommentTwin(row));
}

export type CommentTwinFields = {
  source_comment_id: Id<"comments">;
  conversation_id: Id<"conversations">;
  message_id: Id<"messages"> | undefined;
  author_user_id: Id<"users">;
  author_kind: "user" | "agent" | undefined;
  content: string;
  parent_id: Id<"review_comments"> | undefined;
  created_at: number;
  file_path: string | undefined;
  line_number: number | undefined;
  anchor_lines: Doc<"comments">["anchor_lines"];
  agent_status: Doc<"comments">["agent_status"];
  fork_conversation_id: Id<"conversations"> | undefined;
  resolved: boolean;
  resolved_at: number | undefined;
  resolved_by: Id<"users"> | undefined;
  client_id: string | undefined;
  source_pr_id: Id<"pull_requests"> | undefined;
  source_github_comment_id: number | undefined;
};

export const COMMENT_TWIN_FIELDS: ReadonlyArray<keyof CommentTwinFields> = [
  "source_comment_id",
  "conversation_id",
  "message_id",
  "author_user_id",
  "author_kind",
  "content",
  "parent_id",
  "created_at",
  "file_path",
  "line_number",
  "anchor_lines",
  "agent_status",
  "fork_conversation_id",
  "resolved",
  "resolved_at",
  "resolved_by",
  "client_id",
  "source_pr_id",
  "source_github_comment_id",
];

type CommentSource = Omit<Doc<"comments">, "_creationTime">;

/**
 * The twin of one comment. `parentTwinId` is the twin of the comment's parent,
 * when the parent still exists; a reply whose parent is gone has none, as a
 * reply on review_comments whose parent was removed.
 */
export function commentTwinFields(
  comment: CommentSource,
  parentTwinId?: Id<"review_comments">,
): CommentTwinFields {
  return {
    source_comment_id: comment._id,
    conversation_id: comment.conversation_id,
    message_id: comment.message_id,
    author_user_id: comment.user_id,
    author_kind: comment.author_kind,
    content: comment.content,
    parent_id: comment.parent_comment_id ? parentTwinId : undefined,
    created_at: comment.created_at,
    file_path: comment.file_path,
    line_number: comment.line_number,
    anchor_lines: comment.anchor_lines,
    agent_status: comment.agent_status,
    fork_conversation_id: comment.fork_conversation_id,
    resolved: comment.resolved_at !== undefined && comment.resolved_at !== null,
    resolved_at: comment.resolved_at,
    resolved_by: comment.resolved_by,
    client_id: comment.client_id,
    source_pr_id: comment.pr_id,
    source_github_comment_id: comment.github_comment_id,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  const l = left === null ? undefined : left;
  const r = right === null ? undefined : right;
  if (l === undefined || r === undefined) return l === r;
  if (typeof l === "object" || typeof r === "object") return JSON.stringify(l) === JSON.stringify(r);
  return String(l) === String(r) && typeof l === typeof r;
}

/** The twin fields that differ from what the source says they should be. */
export function commentTwinMismatches(
  twin: Partial<Record<keyof CommentTwinFields, unknown>>,
  expected: CommentTwinFields,
): Array<keyof CommentTwinFields> {
  return COMMENT_TWIN_FIELDS.filter((field) => !sameValue(twin[field], expected[field]));
}

/**
 * A twin back in the shape `comments` rows have, so a surface reading twins
 * renders exactly what it renders from `comments`. The row's id is the source
 * comment's id: the store, the optimistic stubs and every write still speak in
 * `comments` ids. `sourceIdOfTwin` resolves the parent twin to its source.
 */
export function commentRowFromTwin(
  twin: Doc<"review_comments">,
  sourceIdOfTwin: (twinId: Id<"review_comments">) => Id<"comments"> | undefined,
): Doc<"comments"> {
  const row: Record<string, unknown> = {
    _id: twin.source_comment_id,
    _creationTime: twin._creationTime,
    conversation_id: twin.conversation_id,
    message_id: twin.message_id,
    user_id: twin.author_user_id,
    content: twin.content,
    parent_comment_id: twin.parent_id ? sourceIdOfTwin(twin.parent_id) : undefined,
    created_at: twin.created_at,
    github_comment_id: twin.source_github_comment_id,
    pr_id: twin.source_pr_id,
    file_path: twin.file_path,
    line_number: twin.line_number,
    anchor_lines: twin.anchor_lines,
    author_kind: twin.author_kind === "github" ? undefined : twin.author_kind,
    agent_status: twin.agent_status,
    fork_conversation_id: twin.fork_conversation_id,
    resolved_at: twin.resolved_at,
    resolved_by: twin.resolved_by,
    client_id: twin.client_id,
  };
  // A comments row carries only the fields that were written.
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row as Doc<"comments">;
}
