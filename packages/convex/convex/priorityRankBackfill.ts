// One-time backfill for relative rank (prioritiesSchema person_pos, ai_rank):
// every priority still carrying the absolute `rank` and `rank_set_by` they
// replaced. An active one's owner's active priorities in its workspace are
// rewritten together, in the order the absolute rank showed: the ones the
// person ranked get that position as their person_pos, the pass's get it as
// their ai_rank. A row that already holds a person_pos (a move made after the
// deploy) keeps it, and the group's active rows with no old fields (made or
// rewritten since the deploy) follow, as the pass's, in the order they show.
// Any other status only loses the old fields. A rewritten row has neither old
// field, so a run after another, or after passes, writes nothing.
// Run it right after deploy.sh, before the next pass:
//   packages/convex/run.sh priorityRankBackfill:run '{"dryRun":false,"auto":true}'
// Dry run by default; auto:true drains the table page by page.

import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";

type Priority = Doc<"priorities">;

/** The most of one owner's active priorities in one workspace it rewrites at once: the reads' own cap (priorities.ts). */
const GROUP_READ = 200;

export const legacy = (p: Priority) => p.rank !== undefined || p.rank_set_by !== undefined;

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

/**
 * Rewrites one owner's active priorities in one workspace (`group`, every one
 * of them) from the absolute rank to relative rank, in the order it showed.
 * Returns what it wrote, by kind.
 */
export async function backfillGroup(ctx: { db: any }, group: Priority[]): Promise<{ placed: number; slotted: number; appended: number }> {
  const counts = { placed: 0, slotted: 0, appended: 0 };
  const old = legacyOrder(group.filter(legacy));
  for (const [i, r] of old.entries()) {
    const placed = r.person_pos != null || r.rank_set_by === "person";
    await ctx.db.patch(r._id, { rank: undefined, rank_set_by: undefined, ...(r.person_pos != null ? {} : placed ? { person_pos: i + 1 } : { ai_rank: i + 1 }) });
    counts[placed ? "placed" : "slotted"]++;
  }
  for (const [i, r] of effectivePriorityOrder(group.filter((r) => !legacy(r) && r.person_pos == null)).entries()) {
    await ctx.db.patch(r._id, { ai_rank: old.length + i + 1 });
    counts.appended++;
  }
  return counts;
}

export const run = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()), auto: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 100;
    const page = await ctx.db.query("priorities").paginate({ cursor: args.cursor ?? null, numItems });
    // What it rewrites (a dry run: what it would, row by row).
    const counts = { placed: 0, slotted: 0, appended: 0, cleared: 0 };
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
      const wrote = await backfillGroup(ctx, group);
      for (const k of ["placed", "slotted", "appended"] as const) counts[k] += wrote[k];
    }
    if (args.auto && !page.isDone) {
      await ctx.scheduler.runAfter(0, (internal as any).priorityRankBackfill.run, { dryRun, cursor: page.continueCursor, numItems, auto: true });
    }
    return { dryRun, ...counts, scanned: page.page.length, done: page.isDone, cursor: page.continueCursor };
  },
});
