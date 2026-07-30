import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "./localViewRevisions";
import {
  runViewTransition,
  type RevisionMode,
  type ViewWriter,
} from "./lib/viewWriters";

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

export type CommentViewWriter = ViewWriter<"comments">;

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
 * The only raw writer for the comments table.
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
  return await runViewTransition(ctx, {
    table: "comments",
    label: "comment",
    guardInsert(value) {
      if (String(value.conversation_id) !== String(authoritative._id)) {
        throw new Error("Comment insert crossed its bound conversation view");
      }
    },
    guardRow(row) {
      if (String(row.conversation_id) !== String(authoritative._id)) {
        throw new Error("Comment write crossed its bound conversation view");
      }
    },
    coverageTarget: commentsCoverageTarget(authoritative),
  }, revisionMode, transition);
}

export function commentPatchChanges(
  comment: Doc<"comments">,
  patch: Partial<Doc<"comments">>,
): boolean {
  return Object.entries(patch).some(([field, value]) =>
    (comment as Record<string, unknown>)[field] !== value);
}

/** Advance a comment view for one non-command projection patch. */
export async function patchCommentWithRevision(
  ctx: MutationCtx,
  comment: Doc<"comments">,
  patch: Partial<Doc<"comments">>,
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
  comment: Doc<"comments">,
  knownConversation?: Doc<"conversations">,
): Promise<boolean> {
  const conversation = knownConversation ?? await ctx.db.get(comment.conversation_id);
  if (!conversation) return false;
  await runCommentViewTransition(ctx, conversation, "advance", async (writer) => {
    await writer.delete(comment._id);
  });
  return true;
}
