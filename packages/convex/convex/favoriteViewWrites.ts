import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "./localViewRevisions";
import { favoritesCoverageTarget, sameProjection } from "./smallViewContracts";

type RevisionMode = "advance" | "receipt";

export function conversationPatchChanges(
  conversation: Doc<"conversations">,
  patch: Partial<Doc<"conversations">>,
): boolean {
  return Object.entries(patch).some(([field, value]) =>
    !sameProjection((conversation as Record<string, unknown>)[field], value));
}

/**
 * The only raw patch boundary for conversations.is_favorite.
 *
 * Favorites are modeled as a principal-owned relation, not as a second copy of
 * conversation entities. The owner is always re-read from the authoritative
 * conversation. Receipt mode defers head advancement to runLocalCommand so the
 * desired-state write and durable receipt advance exactly once.
 */
export async function patchConversationThroughFavoriteView(
  ctx: MutationCtx,
  knownConversation: Pick<Doc<"conversations">, "_id" | "user_id" | "is_favorite">,
  patch: Partial<Doc<"conversations">>,
  revisionMode: RevisionMode,
): Promise<{
  changed: boolean;
  isFavorite: boolean;
  coverageTarget?: ViewCoverageTarget;
}> {
  const conversation = await ctx.db.get(knownConversation._id);
  if (!conversation) throw new Error("Cannot patch a missing conversation");
  if (String(conversation.user_id) !== String(knownConversation.user_id)) {
    throw new Error("Favorite write crossed its bound principal");
  }
  if ("user_id" in patch && String(patch.user_id) !== String(conversation.user_id)) {
    throw new Error("Favorite writer cannot transfer conversation ownership");
  }

  const changes = conversationPatchChanges(conversation, patch);
  const beforeFavorite = !!conversation.is_favorite;
  const afterFavorite = "is_favorite" in patch ? !!patch.is_favorite : beforeFavorite;
  const favoriteChanged = beforeFavorite !== afterFavorite;
  if (changes) await ctx.db.patch(conversation._id, patch);

  const coverageTarget = favoriteChanged
    ? favoritesCoverageTarget(conversation.user_id)
    : undefined;
  if (coverageTarget && revisionMode === "advance") {
    await advanceLocalViewRevision(
      ctx,
      conversation.user_id,
      coverageTarget.contractId,
      coverageTarget.viewKey,
    );
  }
  return { changed: changes, isFavorite: afterFavorite, coverageTarget };
}

export async function setFavoriteWithRevision(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  isFavorite: boolean,
  revisionMode: RevisionMode,
) {
  return await patchConversationThroughFavoriteView(
    ctx,
    conversation,
    { is_favorite: isFavorite },
    revisionMode,
  );
}

export async function toggleFavoriteWithRevision(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
): Promise<boolean> {
  const result = await setFavoriteWithRevision(ctx, conversation, !conversation.is_favorite, "advance");
  return result.isFavorite;
}

export function favoriteCoverageForConversation(
  conversation: Pick<Doc<"conversations">, "user_id">,
): ViewCoverageTarget {
  return favoritesCoverageTarget(conversation.user_id as Id<"users">);
}
