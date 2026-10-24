// The dual write of conversation comments into review_comments: after any
// write to a `comments` row, its twin is made to match it (lib/commentTwins).
// `comments` stays the source of truth and the write API; this only follows.
//
// One function, reconcileCommentTwin, is the whole rule: read the source, read
// its twin, and insert, patch or delete the twin so it equals
// commentTwinFields(source). The write boundary (commentViewWrites) runs it
// for every row a transition touched, and the backfill runs it for rows
// written before the dual write existed, so both converge on the same twin.
// A leaf: it imports nothing from comments.ts, which imports it indirectly.

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  commentTwinFields,
  commentTwinMismatches,
  isCommentTwin,
} from "./lib/commentTwins";

type Ctx = Pick<MutationCtx, "db">;
type ReadCtx = { db: Pick<MutationCtx["db"], "query" | "get"> };

export type TwinOutcome = "created" | "updated" | "deleted" | "unchanged";

/** Every twin of one comment, oldest first. One, unless a race left two. */
export async function twinsOfComment(
  ctx: ReadCtx,
  commentId: Id<"comments">,
): Promise<Doc<"review_comments">[]> {
  const rows: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_source_comment", (q: any) => q.eq("source_comment_id", commentId))
    .collect();
  return rows
    .filter((row) => isCommentTwin(row) && String(row.source_comment_id) === String(commentId))
    .sort((a, b) => a._creationTime - b._creationTime);
}

async function deleteTwin(ctx: Ctx, twin: Doc<"review_comments">): Promise<void> {
  // A reply whose parent is gone points at no twin, as its source points at
  // no comment that exists.
  const children: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_parent", (q: any) => q.eq("parent_id", twin._id))
    .collect();
  for (const child of children) {
    if (isCommentTwin(child)) await ctx.db.patch(child._id, { parent_id: undefined });
  }
  await ctx.db.delete(twin._id);
}

/** What reconcileCommentTwin would do, without doing it. */
export async function planCommentTwin(
  ctx: ReadCtx,
  commentId: Id<"comments">,
): Promise<TwinOutcome> {
  const source = await ctx.db.get(commentId);
  const twins = await twinsOfComment(ctx, commentId);
  if (!source) return twins.length ? "deleted" : "unchanged";
  if (twins.length === 0) return "created";
  const parentTwin = source.parent_comment_id
    ? (await twinsOfComment(ctx, source.parent_comment_id))[0]
    : undefined;
  const expected = commentTwinFields(source, parentTwin?._id);
  return twins.length > 1 || commentTwinMismatches(twins[0], expected).length > 0 ? "updated" : "unchanged";
}

/**
 * Make one comment's twin equal to the comment. Idempotent by source id: run
 * twice, the second run writes nothing. A comment that no longer exists loses
 * its twin. A reply first makes sure its parent's twin exists, so parent_id
 * names it.
 */
export async function reconcileCommentTwin(
  ctx: Ctx,
  commentId: Id<"comments">,
  depth = 0,
): Promise<{ outcome: TwinOutcome; twinId?: Id<"review_comments"> }> {
  const source = await ctx.db.get(commentId);
  const twins = await twinsOfComment(ctx, commentId);
  if (!source) {
    for (const twin of twins) await deleteTwin(ctx, twin);
    return { outcome: twins.length ? "deleted" : "unchanged" };
  }

  let parentTwinId: Id<"review_comments"> | undefined;
  if (source.parent_comment_id && depth < 8) {
    parentTwinId = (await reconcileCommentTwin(ctx, source.parent_comment_id, depth + 1)).twinId;
  }
  const expected = commentTwinFields(source, parentTwinId);

  const [twin, ...extras] = twins;
  for (const extra of extras) await deleteTwin(ctx, extra);
  if (!twin) {
    const twinId = await ctx.db.insert("review_comments", expected);
    return { outcome: "created", twinId };
  }
  const changed = commentTwinMismatches(twin, expected);
  if (changed.length === 0) {
    return { outcome: extras.length ? "updated" : "unchanged", twinId: twin._id };
  }
  const patch: Record<string, unknown> = {};
  for (const field of changed) patch[field] = expected[field];
  await ctx.db.patch(twin._id, patch as Partial<Doc<"review_comments">>);
  return { outcome: "updated", twinId: twin._id };
}

/**
 * The dual write itself, run by the comments write boundary after a
 * transition. A twin is a copy that nothing reads yet, so a failure here must
 * never fail the comment write a person made: it is logged, and the parity
 * sweep (commentTwins.paritySweep) reports the row until the backfill or the
 * next write repairs it.
 */
export async function mirrorCommentTwins(
  ctx: Ctx,
  commentIds: Iterable<Id<"comments">>,
): Promise<void> {
  for (const commentId of commentIds) {
    try {
      await reconcileCommentTwin(ctx, commentId);
    } catch (error) {
      console.error(`[commentTwins] twin of ${commentId} not written`, error);
    }
  }
}
