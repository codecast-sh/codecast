// Reading conversation comments. They live in review_comments
// (lib/conversationCommentRows has the shape and the id rule); every reader
// goes through these, and every write through commentViewWrites.
// A leaf: it imports nothing from comments.ts or threads.ts.

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  commentIdOf,
  commentsFromRows,
  isConversationComment,
  type CommentId,
  type ConversationComment,
} from "./lib/conversationCommentRows";

type ReadCtx = { db: Pick<MutationCtx["db"], "query" | "get" | "normalizeId"> };

async function conversationRows(ctx: ReadCtx, conversationId: Id<"conversations">): Promise<Doc<"review_comments">[]> {
  return await ctx.db
    .query("review_comments")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
}

/** One conversation's comments in the `comments` shape, unsorted. */
export async function listConversationComments(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
): Promise<ConversationComment[]> {
  return commentsFromRows(await conversationRows(ctx, conversationId));
}

/** The review_comments row behind a comment id of either kind, if it is a
 *  conversation comment. */
export async function commentRowById(ctx: ReadCtx, id: string): Promise<Doc<"review_comments"> | null> {
  const rowId = ctx.db.normalizeId("review_comments", id);
  if (rowId) {
    const row = await ctx.db.get(rowId);
    return row && isConversationComment(row) ? row : null;
  }
  const sourceId = ctx.db.normalizeId("comments", id);
  if (!sourceId) return null;
  const twins: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_source_comment", (q: any) => q.eq("source_comment_id", sourceId))
    .collect();
  return twins
    .filter((row) => String(row.source_comment_id) === String(sourceId))
    .sort((a, b) => a._creationTime - b._creationTime)[0] ?? null;
}

/** One comment by an id of either kind, in the `comments` shape. */
export async function getComment(ctx: ReadCtx, id: CommentId | string): Promise<ConversationComment | null> {
  const row = await commentRowById(ctx, String(id));
  if (!row) return null;
  if (!row.parent_id) return commentsFromRows([row])[0];
  const parent = await ctx.db.get(row.parent_id);
  return commentsFromRows(parent ? [row, parent] : [row]).find((c) => String(c._id) === String(commentIdOf(row)))!;
}

/** The comment a client created under `clientId` in one conversation. */
export async function findCommentByClientId(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
  clientId: string,
): Promise<ConversationComment | null> {
  return (await listConversationComments(ctx, conversationId)).find((c) => c.client_id === clientId) ?? null;
}
