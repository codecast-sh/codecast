import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { advanceLocalViewRevision } from "./localViewRevisions";
import {
  runViewTransition,
  type RevisionMode,
  type ViewWriter,
  type ViewWriterBinding,
} from "./lib/viewWriters";
import { bookmarksCoverageTarget } from "./smallViewContracts";

export type BookmarkViewWriter = ViewWriter<"bookmarks">;

function bookmarkBinding(principalId: Id<"users">): ViewWriterBinding<"bookmarks"> {
  return {
    table: "bookmarks",
    label: "bookmark",
    guardInsert(value) {
      if (String(value.user_id) !== String(principalId)) {
        throw new Error("Bookmark insert crossed its bound principal view");
      }
    },
    guardRow(row) {
      if (String(row.user_id) !== String(principalId)) {
        throw new Error("Bookmark write crossed its bound principal view");
      }
    },
    guardPatch(_row, patch) {
      if ("user_id" in patch && String(patch.user_id) !== String(principalId)) {
        throw new Error("Bookmark writer cannot transfer principal ownership");
      }
    },
    coverageTarget: bookmarksCoverageTarget(principalId),
  };
}

/** The only ordinary raw write boundary for the bookmarks table. */
export async function runBookmarkViewTransition<Result>(
  ctx: MutationCtx,
  principalId: Id<"users">,
  revisionMode: RevisionMode,
  transition: (writer: BookmarkViewWriter) => Promise<Result>,
) {
  return await runViewTransition(ctx, bookmarkBinding(principalId), revisionMode, transition);
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
