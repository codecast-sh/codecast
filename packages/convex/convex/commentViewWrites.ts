import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "./localViewRevisions";

export const COMMENTS_VIEW_CONTRACT_ID = "comments.byConversation/v2";

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

export type CommentViewWriter = {
  insert: (
    value: Omit<Doc<"comments">, "_id" | "_creationTime">,
  ) => Promise<Id<"comments">>;
  patch: (id: Id<"comments">, value: Partial<Doc<"comments">>) => Promise<void>;
  delete: (id: Id<"comments">) => Promise<void>;
};

type RevisionMode = "advance" | "receipt";

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
): Promise<{ result: Result; coverageTarget?: ViewCoverageTarget }> {
  const authoritativeConversation = await ctx.db.get(conversation._id);
  if (!authoritativeConversation) {
    throw new Error("Cannot write comments for a missing conversation");
  }

  const requireBoundComment = async (id: Id<"comments">): Promise<Doc<"comments">> => {
    const comment = await ctx.db.get(id);
    if (!comment) throw new Error("Cannot write a missing comment");
    if (String(comment.conversation_id) !== String(authoritativeConversation._id)) {
      throw new Error("Comment write crossed its bound conversation view");
    }
    return comment;
  };

  let writeCount = 0;
  const writer: CommentViewWriter = {
    async insert(value) {
      if (String(value.conversation_id) !== String(authoritativeConversation._id)) {
        throw new Error("Comment insert crossed its bound conversation view");
      }
      writeCount++;
      return await ctx.db.insert("comments", value);
    },
    async patch(id, value) {
      await requireBoundComment(id);
      writeCount++;
      await ctx.db.patch(id, value);
    },
    async delete(id) {
      await requireBoundComment(id);
      writeCount++;
      await ctx.db.delete(id);
    },
  };

  const result = await transition(writer);
  if (writeCount === 0) return { result };

  const coverageTarget = commentsCoverageTarget(authoritativeConversation);
  if (revisionMode === "advance") {
    await advanceLocalViewRevision(
      ctx,
      authoritativeConversation.user_id,
      coverageTarget.contractId,
      coverageTarget.viewKey,
    );
  }
  return { result, coverageTarget };
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
