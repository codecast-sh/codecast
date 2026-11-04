import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "./localViewRevisions";
import {
  runViewTransition,
  type RevisionMode,
} from "./lib/viewWriters";
import { commentRowById } from "./commentStore";
import {
  isConversationComment,
  rowFromComment,
  rowPatchFromComment,
  type CommentId,
  type ConversationComment,
  type ConversationCommentValue,
} from "./lib/conversationCommentRows";

export const COMMENTS_VIEW_CONTRACT_ID = "comments.byConversation/v2";
/** The stamped-log-ts client contract; same envelope, deeper coverage. */
export const COMMENTS_VIEW_CONTRACT_ID_V3 = "comments.byConversation/v3";

export function commentsViewKey(conversationId: Id<"conversations">): string {
  return `comments:conversation:${conversationId}`;
}

/**
 * Opaque retention grant for one complete comment projection. Clients compare
 * and persist this value; they must not parse or synthesize it.
 */
export function commentsGrantKey(conversationId: Id<"conversations">): string {
  return `comments:conversation-grant:${conversationId}`;
}

export function commentsCoverageTarget(
  conversation: Pick<Doc<"conversations">, "_id" | "user_id">,
): ViewCoverageTarget {
  return {
    contractId: COMMENTS_VIEW_CONTRACT_ID,
    viewKey: commentsViewKey(conversation._id),
    // Shared viewers write the owner's revision domain. This identity is
    // always read from the authoritative conversation, never from arguments.
    revisionPrincipalId: conversation.user_id,
  };
}

/** Writes on conversation comments, in the comment shape and by comment id
 *  of either kind (lib/conversationCommentRows). */
export type CommentViewWriter = {
  insert(value: ConversationCommentValue): Promise<CommentId>;
  patch(id: CommentId, value: Partial<ConversationCommentValue>): Promise<void>;
  delete(id: CommentId): Promise<void>;
};

/**
 * Receipt coverage for stamped-log-ts clients (design §11.4 proof #3): the
 * receipt names this command id against the v3 contract, and the view query
 * echoes the caller's receipted ids from the same snapshot, so the client
 * retires the optimistic overlay exactly when a result provably containing
 * the write lands.
 */
export function commentsCommandIdCoverage(
  conversationId: Id<"conversations">,
): { kind: "command-id"; contractId: string; viewKey: string } {
  return {
    kind: "command-id",
    contractId: COMMENTS_VIEW_CONTRACT_ID_V3,
    viewKey: commentsViewKey(conversationId),
  };
}

/**
 * Advance a conversation's comment view head when an ACCESS input changed
 * (privacy, team, team visibility) without any comment-table write.
 *
 * The client's durable view refuses to re-grant at a revision it already
 * observed before a forbidden transition — a stale cached query result must
 * never resurrect revoked content. That safety rule means every mutation that
 * can change `canAccessConversation`'s outcome must move this head forward,
 * or a viewer who lost and then regained access with zero comment writes in
 * between keeps a frozen (empty) durable comment view until someone comments.
 * (Adversarial sync matrix, finding SRV-02.)
 */
export async function advanceCommentsAccessRevision(
  ctx: MutationCtx,
  conversation: Pick<Doc<"conversations">, "_id" | "user_id">,
): Promise<void> {
  const target = commentsCoverageTarget(conversation);
  await advanceLocalViewRevision(
    ctx,
    target.revisionPrincipalId!,
    target.contractId,
    target.viewKey,
  );
}

/**
 * The only writer of conversation comments. They live in review_comments
 * (commentStore, lib/conversationCommentRows); `comments` is history and
 * nothing writes it.
 *
 * A semantic operation may insert and then enrich the same projection (the
 * ask-agent placeholder is the important case). The callback groups those row
 * writes into one view transition, and this boundary advances the exact view
 * head once. Receipt-backed commands defer that single advance to
 * runLocalCommand so the domain write, coverage, and durable receipt commit in
 * one transaction.
 */
export async function runCommentViewTransition<Result>(
  ctx: MutationCtx,
  conversation: Pick<Doc<"conversations">, "_id" | "user_id">,
  revisionMode: RevisionMode,
  transition: (writer: CommentViewWriter) => Promise<Result>,
) {
  const authoritative = await ctx.db.get(conversation._id);
  if (!authoritative) {
    throw new Error("Cannot write comments for a missing conversation");
  }
  const inConversation = (conversationId: unknown) => String(conversationId) === String(authoritative._id);
  const rowOf = async (id: CommentId): Promise<Id<"review_comments">> => {
    const row = await commentRowById(ctx, String(id));
    if (!row) throw new Error("Cannot write a missing comment");
    return row._id;
  };
  return await runViewTransition(ctx, {
    table: "review_comments",
    label: "comment",
    guardInsert(value) {
      if (!inConversation(value.conversation_id)) {
        throw new Error("Comment insert crossed its bound conversation view");
      }
    },
    guardRow(row) {
      if (!isConversationComment(row) || !inConversation(row.conversation_id)) {
        throw new Error("Comment write crossed its bound conversation view");
      }
    },
    coverageTarget: commentsCoverageTarget(authoritative),
  }, revisionMode, (writer) => transition({
    async insert(value) {
      const parentRowId = value.parent_comment_id ? await rowOf(value.parent_comment_id) : undefined;
      return await writer.insert(rowFromComment(value, parentRowId));
    },
    async patch(id, value) {
      await writer.patch(await rowOf(id), rowPatchFromComment(value));
    },
    async delete(id) {
      const rowId = await rowOf(id);
      // A reply whose parent is gone has no parent, as before.
      const replies: Doc<"review_comments">[] = await ctx.db
        .query("review_comments")
        .withIndex("by_parent", (q: any) => q.eq("parent_id", rowId))
        .collect();
      for (const reply of replies) {
        if (isConversationComment(reply)) await writer.patch(reply._id, { parent_id: undefined });
      }
      await writer.delete(rowId);
    },
  }));
}

export function commentPatchChanges(
  comment: ConversationComment,
  patch: Partial<ConversationCommentValue>,
): boolean {
  return Object.entries(patch).some(([field, value]) =>
    (comment as Record<string, unknown>)[field] !== value);
}

/** Advance a comment view for one non-command projection patch. */
export async function patchCommentWithRevision(
  ctx: MutationCtx,
  comment: ConversationComment,
  patch: Partial<ConversationCommentValue>,
  knownConversation?: Doc<"conversations">,
): Promise<boolean> {
  if (!commentPatchChanges(comment, patch)) return false;
  const conversation = knownConversation ?? await ctx.db.get(comment.conversation_id);
  if (!conversation) return false;
  await runCommentViewTransition(ctx, conversation, "advance", async (writer) => {
    await writer.patch(comment._id, patch);
  });
  return true;
}

/** Advance a comment view for one non-command deletion. */
export async function deleteCommentWithRevision(
  ctx: MutationCtx,
  comment: ConversationComment,
  knownConversation?: Doc<"conversations">,
): Promise<boolean> {
  const conversation = knownConversation ?? await ctx.db.get(comment.conversation_id);
  if (!conversation) return false;
  await runCommentViewTransition(ctx, conversation, "advance", async (writer) => {
    await writer.delete(comment._id);
  });
  return true;
}
