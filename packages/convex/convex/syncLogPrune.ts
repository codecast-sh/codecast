// Sync-log retention (design D10, docs/architecture/sync-log-migration.md).
//
// Deletes sync_actions older than the retention window in bounded batches and
// advances each affected scope's floor to the highest pruned position. A client
// whose cursor is below a floor gets `resync: true` from getRange and re-runs its
// full backfill — the documented recovery for "away longer than retention".
//
// Coalescing keeps an actively-churning entity's row fresh (its ts moves with
// every write), so pruning only ever removes rows whose entities have been quiet
// for the whole window, delete/revocation tombstones, and old scope actions.
// Heads are never deleted. Separate file from syncLog.ts because this needs the
// wrapped builders from ./functions, which itself imports syncLog helpers.
import { v } from "convex/values";
import { internalMutation } from "./functions";

export const SYNC_ACTIONS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_BATCH = 500;

// Pure: fold pruned rows into the per-scope floor advance. Unit-tested.
export function floorAdvances(
  pruned: Array<{ scope_key: string; position: number }>,
): Map<string, number> {
  const advances = new Map<string, number>();
  for (const row of pruned) {
    const cur = advances.get(row.scope_key);
    if (cur === undefined || row.position > cur) advances.set(row.scope_key, row.position);
  }
  return advances;
}

export const pruneSyncActions = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - SYNC_ACTIONS_RETENTION_MS;
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_PRUNE_BATCH, 1), 1000);
    const stale = await ctx.db
      .query("sync_actions")
      .withIndex("by_ts", (q: any) => q.lt("ts", cutoff))
      .take(limit);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    const advances = floorAdvances(
      stale.map((r: any) => ({ scope_key: r.scope_key, position: r.position })),
    );
    for (const [scopeKey, maxPruned] of advances) {
      const head = await ctx.db
        .query("sync_heads")
        .withIndex("by_scope", (q: any) => q.eq("scope_key", scopeKey))
        .unique();
      if (head && maxPruned > (head.floor ?? 0)) {
        await ctx.db.patch(head._id, { floor: maxPruned });
      }
    }
    return { pruned: stale.length };
  },
});
