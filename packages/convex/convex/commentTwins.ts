// Conversation comments in review_comments: the backfill, the parity sweep and
// the read path behind the per-user flag (lib/commentTwins has the mapping,
// commentTwinWrites the dual write).
//
//   npx convex run commentTwins:backfill '{}'                              # dry run, one page
//   npx convex run commentTwins:backfill '{"dryRun":false,"auto":true}'    # write every page
//   npx convex run commentTwins:paritySweep '{}'                           # report only
//
// `comments` stays the source of truth: the backfill only writes twins, and
// the sweep writes nothing.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessConversation } from "./lib/access";
import {
  commentRowFromTwin,
  commentTwinFields,
  commentTwinMismatches,
  isCommentTwin,
} from "./lib/commentTwins";
import { planCommentTwin, reconcileCommentTwin, twinsOfComment } from "./commentTwinWrites";
import { commentSummaryRows } from "./comments";

type ReadCtx = { db: any };

// ── Read ─────────────────────────────────────────────────────────────────────

/** One conversation's comments, read from their twins and shaped as `comments`
 *  rows (ids are the source comment ids). */
export async function conversationCommentRowsFromTwins(
  ctx: ReadCtx,
  conversationId: Id<"conversations">,
): Promise<Doc<"comments">[]> {
  const rows: Doc<"review_comments">[] = await ctx.db
    .query("review_comments")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  const twins = rows.filter(isCommentTwin);
  const sourceOf = new Map(twins.map((twin) => [String(twin._id), twin.source_comment_id!]));
  return twins.map((twin) => commentRowFromTwin(twin, (id) => sourceOf.get(String(id))));
}

/**
 * getConversationCommentSummary, answered from review_comments. Same access
 * rule (canAccessConversation on the conversation), same row shape, same
 * order. Read by every client unless its person set `comments_from_review` to false.
 */
export const conversationComments = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    if (!(await canAccessConversation(ctx, userId, conversation))) return [];
    return await commentSummaryRows(ctx, await conversationCommentRowsFromTwins(ctx, args.conversation_id));
  },
});

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * Give every comment written before the dual write its twin, and repair any
 * twin that drifted. Pages `comments` in creation order (a parent before its
 * replies), dry run unless dryRun:false, idempotent by source id, and with
 * auto:true schedules the next page itself. Pages are small: each comment
 * also reads its twin, and a reply its parent's.
 */
export const backfill = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = Math.min(Math.max(args.numItems ?? 100, 1), 200);
    const page = await ctx.db
      .query("comments")
      .withIndex("by_creation_time")
      .paginate({ cursor: args.cursor ?? null, numItems });

    const counts = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
    for (const comment of page.page) {
      const outcome = dryRun
        ? await planCommentTwin(ctx, comment._id)
        : (await reconcileCommentTwin(ctx, comment._id)).outcome;
      counts[outcome]++;
    }

    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.commentTwins.backfill, {
        dryRun,
        cursor: page.continueCursor,
        numItems,
        auto: true,
      });
    }
    return { dryRun, ...counts, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});

// ── Parity sweep ─────────────────────────────────────────────────────────────

const SAMPLE_LIMIT = 20;

export type ParityPage = {
  phase: "comments" | "twins";
  scanned: number;
  missing_twin: string[];
  duplicate_twin: string[];
  mismatched: Array<{ comment_id: string; fields: string[] }>;
  orphan_twin: string[];
  done: boolean;
  cursor: string;
};

/**
 * One page of the comparison. Phase "comments" walks `comments` and finds rows
 * with no twin, more than one, or a twin whose fields differ from the mapping.
 * Phase "twins" walks the twins and finds those whose source is gone. Reads
 * only.
 */
export const parityPage = internalQuery({
  args: {
    phase: v.union(v.literal("comments"), v.literal("twins")),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ParityPage> => {
    const numItems = Math.min(Math.max(args.numItems ?? 200, 1), 500);
    const out: ParityPage = {
      phase: args.phase,
      scanned: 0,
      missing_twin: [],
      duplicate_twin: [],
      mismatched: [],
      orphan_twin: [],
      done: true,
      cursor: "",
    };
    if (args.phase === "comments") {
      const page = await ctx.db
        .query("comments")
        .withIndex("by_creation_time")
        .paginate({ cursor: args.cursor ?? null, numItems });
      for (const comment of page.page) {
        const twins = await twinsOfComment(ctx, comment._id);
        if (twins.length === 0) {
          out.missing_twin.push(String(comment._id));
          continue;
        }
        if (twins.length > 1) out.duplicate_twin.push(String(comment._id));
        const parentTwin = comment.parent_comment_id
          ? (await twinsOfComment(ctx, comment.parent_comment_id))[0]
          : undefined;
        const fields = commentTwinMismatches(twins[0], commentTwinFields(comment, parentTwin?._id));
        if (fields.length) out.mismatched.push({ comment_id: String(comment._id), fields });
      }
      Object.assign(out, { scanned: page.page.length, done: page.isDone, cursor: page.continueCursor });
      return out;
    }
    // Rows without a source id sort below every string in the index, so this
    // range holds only twins.
    const page = await ctx.db
      .query("review_comments")
      .withIndex("by_source_comment", (q: any) => q.gt("source_comment_id", ""))
      .paginate({ cursor: args.cursor ?? null, numItems });
    for (const twin of page.page) {
      if (!isCommentTwin(twin)) continue;
      if (!(await ctx.db.get(twin.source_comment_id!))) out.orphan_twin.push(String(twin._id));
    }
    Object.assign(out, { scanned: page.page.length, done: page.isDone, cursor: page.continueCursor });
    return out;
  },
});

export type ParityReport = {
  comments_scanned: number;
  twins_scanned: number;
  missing_twin: number;
  duplicate_twin: number;
  mismatched: number;
  orphan_twin: number;
  mismatched_fields: Record<string, number>;
  samples: {
    missing_twin: string[];
    duplicate_twin: string[];
    mismatched: Array<{ comment_id: string; fields: string[] }>;
    orphan_twin: string[];
  };
  clean: boolean;
};

/** Fold parity pages into one report: counts, per-field mismatch counts and
 *  up to SAMPLE_LIMIT sample ids of each finding. */
export function foldParityPages(pages: ParityPage[]): ParityReport {
  const report: ParityReport = {
    comments_scanned: 0,
    twins_scanned: 0,
    missing_twin: 0,
    duplicate_twin: 0,
    mismatched: 0,
    orphan_twin: 0,
    mismatched_fields: {},
    samples: { missing_twin: [], duplicate_twin: [], mismatched: [], orphan_twin: [] },
    clean: true,
  };
  const sample = <T>(into: T[], from: T[]) => {
    for (const item of from) if (into.length < SAMPLE_LIMIT) into.push(item);
  };
  for (const page of pages) {
    if (page.phase === "comments") report.comments_scanned += page.scanned;
    else report.twins_scanned += page.scanned;
    report.missing_twin += page.missing_twin.length;
    report.duplicate_twin += page.duplicate_twin.length;
    report.mismatched += page.mismatched.length;
    report.orphan_twin += page.orphan_twin.length;
    for (const m of page.mismatched) {
      for (const field of m.fields) report.mismatched_fields[field] = (report.mismatched_fields[field] ?? 0) + 1;
    }
    sample(report.samples.missing_twin, page.missing_twin);
    sample(report.samples.duplicate_twin, page.duplicate_twin);
    sample(report.samples.mismatched, page.mismatched);
    sample(report.samples.orphan_twin, page.orphan_twin);
  }
  report.clean = report.missing_twin + report.duplicate_twin + report.mismatched + report.orphan_twin === 0;
  return report;
}

/** The whole comparison: every page of both phases, folded into one report. */
export const paritySweep = internalAction({
  args: { numItems: v.optional(v.number()) },
  handler: async (ctx, args): Promise<ParityReport> => {
    const pages: ParityPage[] = [];
    for (const phase of ["comments", "twins"] as const) {
      let cursor: string | undefined;
      for (;;) {
        const page: ParityPage = await ctx.runQuery(internal.commentTwins.parityPage, {
          phase,
          cursor,
          numItems: args.numItems,
        });
        pages.push(page);
        if (page.done) break;
        cursor = page.cursor;
      }
    }
    return foldParityPages(pages);
  },
});
