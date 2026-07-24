import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  advanceLocalViewRevision,
  type ViewCoverageTarget,
} from "./localViewRevisions";
import { bookmarksCoverageTarget } from "./smallViewContracts";

type RevisionMode = "advance" | "receipt";

export type BookmarkViewWriter = {
  insert: (
    value: Omit<Doc<"bookmarks">, "_id" | "_creationTime">,
  ) => Promise<Id<"bookmarks">>;
  patch: (id: Id<"bookmarks">, value: Partial<Doc<"bookmarks">>) => Promise<void>;
  delete: (id: Id<"bookmarks">) => Promise<void>;
};

/** The only ordinary raw write boundary for the bookmarks table. */
export async function runBookmarkViewTransition<Result>(
  ctx: MutationCtx,
  principalId: Id<"users">,
  revisionMode: RevisionMode,
  transition: (writer: BookmarkViewWriter) => Promise<Result>,
): Promise<{ result: Result; coverageTarget?: ViewCoverageTarget }> {
  const requireBoundBookmark = async (id: Id<"bookmarks">): Promise<Doc<"bookmarks">> => {
    const bookmark = await ctx.db.get(id);
    if (!bookmark) throw new Error("Cannot write a missing bookmark");
    if (String(bookmark.user_id) !== String(principalId)) {
      throw new Error("Bookmark write crossed its bound principal view");
    }
    return bookmark;
  };

  let writeCount = 0;
  const writer: BookmarkViewWriter = {
    async insert(value) {
      if (String(value.user_id) !== String(principalId)) {
        throw new Error("Bookmark insert crossed its bound principal view");
      }
      writeCount++;
      return await ctx.db.insert("bookmarks", value);
    },
    async patch(id, value) {
      await requireBoundBookmark(id);
      if ("user_id" in value && String(value.user_id) !== String(principalId)) {
        throw new Error("Bookmark writer cannot transfer principal ownership");
      }
      writeCount++;
      await ctx.db.patch(id, value);
    },
    async delete(id) {
      await requireBoundBookmark(id);
      writeCount++;
      await ctx.db.delete(id);
    },
  };

  const result = await transition(writer);
  if (writeCount === 0) return { result };
  const coverageTarget = bookmarksCoverageTarget(principalId);
  if (revisionMode === "advance") {
    await advanceLocalViewRevision(
      ctx,
      principalId,
      coverageTarget.contractId,
      coverageTarget.viewKey,
    );
  }
  return { result, coverageTarget };
}

export async function insertBookmarkWithRevision(
  ctx: MutationCtx,
  value: Omit<Doc<"bookmarks">, "_id" | "_creationTime">,
  revisionMode: RevisionMode = "advance",
) {
  return await runBookmarkViewTransition(
    ctx,
    value.user_id,
    revisionMode,
    async (writer) => await writer.insert(value),
  );
}

export async function deleteBookmarkWithRevision(
  ctx: MutationCtx,
  bookmark: Doc<"bookmarks">,
  revisionMode: RevisionMode = "advance",
) {
  return await runBookmarkViewTransition(
    ctx,
    bookmark.user_id,
    revisionMode,
    async (writer) => await writer.delete(bookmark._id),
  );
}

/** Admin-only ownership transfer advances both server-derived principal heads. */
export async function moveBookmarkPrincipalWithRevision(
  ctx: MutationCtx,
  bookmark: Doc<"bookmarks">,
  toPrincipalId: Id<"users">,
): Promise<boolean> {
  const authoritative = await ctx.db.get(bookmark._id);
  if (!authoritative) return false;
  if (String(authoritative.user_id) !== String(bookmark.user_id)) {
    throw new Error("Bookmark ownership changed before transfer");
  }
  if (String(authoritative.user_id) === String(toPrincipalId)) return false;

  // This exceptional raw patch is kept in the same ownership boundary rather
  // than weakening the ordinary writer to permit arbitrary cross-principal moves.
  await ctx.db.patch(authoritative._id, { user_id: toPrincipalId });
  for (const principalId of [authoritative.user_id, toPrincipalId]) {
    const target = bookmarksCoverageTarget(principalId);
    await advanceLocalViewRevision(ctx, principalId, target.contractId, target.viewKey);
  }
  return true;
}
