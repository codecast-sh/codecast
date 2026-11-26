// One-time backfill for relative rank (prioritiesSchema person_pos, ai_rank):
// every priority still carrying the absolute `rank` and `rank_set_by` they
// replaced. An active one's owner's active priorities in its workspace are
// rewritten together, in the order they show now: the ones the person ranked
// get that position as their person_pos, the pass's get it as their ai_rank,
// so the order holds exactly. Any other status only loses the old fields. A
// rewritten row has neither field left, so a second run writes nothing.
// Dry run by default; auto:true drains the table page by page.
//   packages/convex/run.sh priorityRankBackfill:run '{"dryRun":false,"auto":true}'
// Once it reports done, delete `rank` and `rank_set_by` from the schema and this file.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

type Priority = Doc<"priorities">;

/** The most of one owner's active priorities in one workspace it rewrites at once: the reads' own cap (priorities.ts). */
const GROUP_READ = 200;

const legacy = (p: Priority) => p.rank !== undefined || p.rank_set_by !== undefined;

/**
 * The order the absolute rank showed (the order it replaced): a rank the
 * person set is a fixed slot, the most recently set winning a shared one; the
 * pass's ranks fill the free slots in their order, unranked last, the most
 * recently active first.
 */
export function legacyOrder(rows: Priority[]): Priority[] {
  const pinned = rows.filter((r) => r.rank_set_by === "person" && r.rank != null).sort((a, b) => a.rank! - b.rank! || b.updated_at - a.updated_at);
  const flowing = rows.filter((r) => !pinned.includes(r)).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.last_active_at - a.last_active_at);
  const slots = new Map<number, Priority>();
  for (const r of pinned) {
    let at = Math.max(1, r.rank!);
    while (slots.has(at)) at++;
    slots.set(at, r);
  }
  let next = 1;
  for (const r of flowing) {
    while (slots.has(next)) next++;
    slots.set(next, r);
  }
  return [...slots.entries()].sort(([a], [b]) => a - b).map(([, r]) => r);
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()), auto: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 100;
    const page = await ctx.db.query("priorities").paginate({ cursor: args.cursor ?? null, numItems });
    // What it rewrites (a dry run: what it would, row by row).
    const counts = { placed: 0, slotted: 0, cleared: 0 };
    for (const listed of page.page) {
      // Read again: a group rewritten earlier in this run has moved on.
      const p = await ctx.db.get(listed._id);
      if (!p || !legacy(p)) continue;
      if (p.status !== "active") {
        if (!dryRun) await ctx.db.patch(p._id, { rank: undefined, rank_set_by: undefined });
        counts.cleared++;
        continue;
      }
      if (dryRun) {
        counts[p.rank_set_by === "person" ? "placed" : "slotted"]++;
        continue;
      }
      const group: Priority[] = await ctx.db
        .query("priorities")
        .withIndex("by_user_workspace_status", (q) => q.eq("user_id", p.user_id).eq("workspace", p.workspace).eq("status", "active"))
        .take(GROUP_READ);
      for (const [i, r] of legacyOrder(group.filter(legacy)).entries()) {
        const placed = r.rank_set_by === "person";
        await ctx.db.patch(r._id, { rank: undefined, rank_set_by: undefined, ...(placed ? { person_pos: i + 1 } : { ai_rank: i + 1 }) });
        counts[placed ? "placed" : "slotted"]++;
      }
    }
    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, (internal as any).priorityRankBackfill.run, { dryRun, cursor: page.continueCursor, numItems, auto: true });
    }
    return { dryRun, ...counts, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});
