// What a deleted board, sheet or dashboard leaves outside its docs row, and the
// job that clears it (scheduled by docs.remove). Its own module so the live
// artifact entry module stays small.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";

/** Rows purgeDoc deletes in one transaction before it schedules the rest. */
const PURGE_ROWS = 500;

/**
 * Delete what a deleted board, sheet or dashboard kept outside its docs row:
 * elements (comments included), the op log, versions and their snapshots, the
 * search row, presence and the head. Scheduled by docs.remove; runs in pages
 * and reschedules itself until nothing is left. A doc that still exists is
 * never touched.
 */
export const purgeDoc = internalMutation({
  args: { doc_id: v.id("docs") },
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.doc_id)) return { purged: 0, done: true };
    let budget = PURGE_ROWS;
    const byDoc = (q: any) => q.eq("doc_id", args.doc_id);
    const tables: Array<[string, string]> = [
      ["live_elements", "by_doc_rev"],
      ["live_batches", "by_doc_rev"],
      ["live_versions", "by_doc_rev"],
      ["live_search", "by_doc"],
      ["live_presence", "by_doc_updated"],
      ["live_heads", "by_doc"],
    ];
    for (const [table, index] of tables) {
      if (budget <= 0) break;
      const rows = await (ctx.db.query(table as any) as any).withIndex(index, byDoc).take(budget);
      for (const r of rows) {
        if (table === "live_versions" && r.snapshot) await ctx.storage.delete(r.snapshot).catch(() => {});
        await ctx.db.delete(r._id);
      }
      budget -= rows.length;
    }
    const purged = PURGE_ROWS - budget;
    const done = budget > 0;
    if (!done) await ctx.scheduler.runAfter(0, internal.liveArtifactPurge.purgeDoc, { doc_id: args.doc_id });
    return { purged, done };
  },
});
