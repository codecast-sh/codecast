// Test fixtures for conversation comments, which live in review_comments
// (lib/conversationCommentRows). Seeds are written in the `comments` shape
// every surface reads, and each keeps its _id, so a parent named by
// parent_comment_id is the seeded row of that id.

import { commentsFromRows, rowFromComment } from "./lib/conversationCommentRows";

/** A conversation comment written in the `comments` shape, as its row. */
export function commentRow(comment: Record<string, any>): any {
  const { _id, _creationTime, ...value } = comment;
  return {
    _id,
    ...(_creationTime === undefined ? {} : { _creationTime }),
    ...rowFromComment(value as any, value.parent_comment_id),
  };
}

/** A twin of a `comments` row written before the write path moved: it goes
 *  by the source id. */
export function legacyCommentRow(rowId: string, comment: Record<string, any>): any {
  const { origin: _origin, ...row } = commentRow({ ...comment, _id: rowId });
  return { ...row, source_comment_id: comment._id };
}

/** Every conversation comment in a fake db, in the `comments` shape. */
export function storedComments(db: any): any[] {
  return commentsFromRows(db._tables.review_comments ?? []);
}
