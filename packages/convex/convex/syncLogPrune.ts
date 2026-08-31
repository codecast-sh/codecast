// Sync-log retention (design D10, docs/architecture/sync-log-migration.md).
//
// Per-scope PREFIX walk, never a global ts sweep: for each scope, read ascending by
// position and delete the prefix of actions older than the retention window, stopping
// at the first young action. The floor advances to the last deleted position, and a
// walk that empties the scope sets floor = head — so a client returning after the
// window always gets `resync: true` instead of silently reading an empty range as
// "caught up". This shape makes no monotonicity assumption about ts (which retries
// can resample out of position order); ts stays what the design says it is,
// retention metadata.
//
// Transaction shape (review C1/C14): one run processes a BOUNDED batch of scopes and
// self-continues via the scheduler, so the read set never grows with total scope
// count and can never cross Convex's per-transaction document limits. Each scope is
// PROBED first — one indexed .first() past the floor — and skipped when its oldest
// retained action is still young, so quiet scopes cost one read, not a page. The
// full-table heads read of the naive version also made every concurrent tracked
// write an OCC conflict; the bounded batch keeps the read set small.
//
// Observability (design D10): each chain reports the oldest retained action's age
// via the by_ts index. If that age exceeds ~32 days the cron is failing — the log
// line is the alarm condition.
import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";

export const SYNC_ACTIONS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_ALARM_MS = 32 * 24 * 60 * 60 * 1000;
// Scopes probed per transaction. Worst case reads per run ≈ HEADS_PER_RUN heads
// + HEADS_PER_RUN probes + (deleted rows ≤ DELETE_BUDGET) — far under limits.
const HEADS_PER_RUN = 32;
const DELETE_BUDGET = 400;
const PER_SCOPE_PAGE = 100;

// Pure: given one scope's ascending action page, pick the deletable prefix.
// Unit-tested. Returns the rows to delete and whether the walk stopped early
// (hit a young row — the scope is fully drained for this window).
export function prunablePrefix<T extends { ts: number }>(
  ascending: T[],
  cutoff: number,
): { toDelete: T[]; stoppedEarly: boolean } {
  const toDelete: T[] = [];
  for (const row of ascending) {
    if (row.ts >= cutoff) return { toDelete, stoppedEarly: true };
    toDelete.push(row);
  }
  return { toDelete, stoppedEarly: false };
}

// One scope's prune step, split out of the mutation so the floor contract is
// unit-testable against a fake db (the two floor branches below are what a
// returning client's `resync` verdict hangs on). Returns rows pruned and the
// budget left; `done` is false when the walk ran out of budget mid-scope, so
// the chain re-enters this scope on its next run.
export async function pruneScope(
  db: any,
  head: { _id: any; scope_key: string; position: number; floor?: number },
  cutoff: number,
  budget: number,
): Promise<{ pruned: number; budget: number; done: boolean }> {
  let pruned = 0;
  // Probe: the oldest retained action past the floor. Young (or absent with
  // nothing to advance) → this scope costs exactly one read.
  const oldest = await db
    .query("sync_actions")
    .withIndex("by_scope_position", (q: any) =>
      q.eq("scope_key", head.scope_key).gt("position", head.floor ?? 0))
    .order("asc")
    .first();
  if (!oldest) {
    // Nothing above the floor: if the head advanced past the floor, every
    // action aged out earlier — set floor = head so a returning client
    // resyncs instead of mistaking emptiness for caught-up.
    if ((head.floor ?? 0) < head.position) {
      await db.patch(head._id, { floor: head.position });
    }
    return { pruned, budget, done: true };
  }
  if (oldest.ts >= cutoff) return { pruned, budget, done: true }; // fully drained for this window

  // Walk the prunable prefix.
  let from = head.floor ?? 0;
  let newFloor = head.floor ?? 0;
  let sawEnd = false;
  let stoppedAtYoung = false;
  while (budget > 0) {
    const pageLimit = Math.min(PER_SCOPE_PAGE, budget);
    const page: { _id: any; ts: number; position: number }[] = await db
      .query("sync_actions")
      .withIndex("by_scope_position", (q: any) =>
        q.eq("scope_key", head.scope_key).gt("position", from))
      .order("asc")
      .take(pageLimit);
    const { toDelete, stoppedEarly } = prunablePrefix(page, cutoff);
    for (const row of toDelete) {
      await db.delete(row._id);
      newFloor = row.position;
      pruned++;
      budget--;
    }
    if (stoppedEarly) { stoppedAtYoung = true; break; }
    if (page.length < pageLimit) { sawEnd = true; break; }
    from = page[page.length - 1].position;
  }
  // The scope drained: every remaining position up to the head is a hole (a
  // coalesced move left it), so the floor is the head — a cursor below it
  // missed a row that is now gone and must resync.
  if (sawEnd && newFloor < head.position) newFloor = head.position;
  if (newFloor > (head.floor ?? 0)) {
    await db.patch(head._id, { floor: newFloor });
  }
  return { pruned, budget, done: sawEnd || stoppedAtYoung };
}

export const pruneSyncActions = internalMutation({
  args: {
    // Continuation cursor: process heads with scope_key greater than this
    // (indexed range on by_scope — the read set is the batch, never the table).
    // Absent on the cron's first invocation of a chain.
    after_scope_key: v.optional(v.string()),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ pruned: number; done: boolean }> => {
    const cutoff = Date.now() - SYNC_ACTIONS_RETENTION_MS;
    let budget = Math.min(Math.max(args.budget ?? DELETE_BUDGET, 1), 2000);
    let pruned = 0;

    // Page the heads themselves: a bounded batch per transaction over the
    // by_scope index (scope_key is unique per head). New heads created
    // mid-chain sort wherever they sort; a later chain picks them up.
    const heads = await ctx.db
      .query("sync_heads")
      .withIndex("by_scope", (q: any) =>
        args.after_scope_key ? q.gt("scope_key", args.after_scope_key) : q)
      .order("asc")
      .take(HEADS_PER_RUN + 1);
    const batch = heads.slice(0, HEADS_PER_RUN);
    const hasMoreHeads = heads.length > HEADS_PER_RUN;

    for (const head of batch) {
      if (budget <= 0) break;
      const r = await pruneScope(ctx.db, head, cutoff, budget);
      pruned += r.pruned;
      budget = r.budget;
    }

    const done = !hasMoreHeads && budget > 0;
    if (!done) {
      // Self-continue: next batch of heads (or re-enter this one when the
      // delete budget ran out before its scopes drained).
      const nextAfter = budget > 0 && batch.length > 0
        ? batch[batch.length - 1].scope_key
        : args.after_scope_key;
      await ctx.scheduler.runAfter(1000, internal.syncLogPrune.pruneSyncActions, {
        ...(nextAfter ? { after_scope_key: nextAfter } : {}),
      });
    } else {
      // End of chain: the D10 alarm condition. The oldest retained action
      // anywhere should never exceed ~32 days if pruning keeps up.
      const oldestOverall = await ctx.db
        .query("sync_actions")
        .withIndex("by_ts")
        .order("asc")
        .first();
      if (oldestOverall) {
        const ageDays = (Date.now() - oldestOverall.ts) / (24 * 60 * 60 * 1000);
        if (Date.now() - oldestOverall.ts > RETENTION_ALARM_MS) {
          console.error(`[syncLogPrune] RETENTION STALLED: oldest retained action is ${ageDays.toFixed(1)}d old (alarm at 32d)`);
        } else {
          console.log(`[syncLogPrune] chain done; oldest retained action ${ageDays.toFixed(1)}d old`);
        }
      }
    }
    return { pruned, done };
  },
});
