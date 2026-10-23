import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, query } from "./functions";
import { appendSyncAction, isLifecycleEntity, makeSyncAckCollector, syncLogDisabled } from "./syncLog";
import { heldKeysFor } from "./lib/accessKeys";
import { pendingJob } from "./lib/pendingJob";
import { scheduleDrain } from "./syncOutboxWriter";

export async function drainSyncOutbox(ctx: any, id: string) {
  if (syncLogDisabled()) return;
  const first = await ctx.db.get(id);
  if (!first?.pending) return;
  const rows = await ctx.db.query("sync_outbox")
    .withIndex("by_scope_pending", (q: any) => q.eq("scope_key", first.scope_key).eq("pending", true))
    .take(32);
  for (const row of rows) {
    let deliveredRevision = row.revision;
    let remaining;
    let position = row.position;
    if (isLifecycleEntity(row.entity_type)) {
      const events = (row.events ?? []).slice(0, 32);
      for (const event of events) {
        const ack = makeSyncAckCollector();
        await appendSyncAction(ctx.db, ack, row.scope_key, row.entity_type, row.entity_id, event.op);
        position = ack.positions.at(-1)!.position;
        deliveredRevision = event.revision;
      }
      remaining = row.events?.slice(events.length);
    } else {
      const ack = makeSyncAckCollector();
      await appendSyncAction(ctx.db, ack, row.scope_key, row.entity_type, row.entity_id, row.op, {
        cargo: row.cargo, access: async () => row.access ?? null,
      });
      position = ack.positions.at(-1)!.position;
    }
    const pending = !!remaining?.length;
    await ctx.db.patch(row._id, {
      delivered_revision: deliveredRevision, position, pending,
      cargo: undefined, access: undefined, events: pending ? remaining : undefined,
      drain_job: pending ? row.drain_job : undefined,
    });
    // Another save's drain for a slot this pass delivered would wake to find
    // nothing: cancel it. The running drain is the one scheduled for `id`.
    if (!pending && row._id !== id && (await pendingJob(ctx, row.drain_job))) await ctx.scheduler.cancel(row.drain_job);
  }
  // One follow-up for the scope, which also covers a lifecycle slot whose
  // events ran past this pass's cap: it is still pending. A slot whose own
  // drain is still waiting already has one.
  const next = await ctx.db.query("sync_outbox")
    .withIndex("by_scope_pending", (q: any) => q.eq("scope_key", first.scope_key).eq("pending", true))
    .first();
  if (next && (next._id === id || !(await pendingJob(ctx, next.drain_job)))) await scheduleDrain(ctx, next._id);
}

export const drain = internalMutation({
  args: { id: v.id("sync_outbox") },
  handler: async (ctx, { id }) => drainSyncOutbox(ctx, id),
});

export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (syncLogDisabled()) return;
    const rows = await ctx.db.query("sync_outbox")
      .withIndex("by_pending", (q) => q.eq("pending", true)).take(100);
    // A scope with a drain still waiting needs no other; one runs late when
    // the scheduler is behind, and a new one every minute only adds to that.
    const waiting = new Set<string>();
    for (const row of rows) if (await pendingJob(ctx, row.drain_job)) waiting.add(row.scope_key);
    for (const row of rows) {
      if (waiting.has(row.scope_key)) continue;
      waiting.add(row.scope_key);
      await scheduleDrain(ctx, row._id);
    }
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db.query("sync_outbox")
      .withIndex("by_pending", (q) => q.eq("pending", true)).take(1001);
    return { pending: pending.length, truncated: pending.length === 1001,
      oldestAgeMs: pending.length ? Date.now() - pending[0].updated_at : 0 };
  },
});

export async function readDeliveryReceipts(db: any, receipts: Array<{ id: string; revision: number }>, heldKeys: ReadonlySet<string>) {
  return Promise.all(receipts.slice(0, 100).map(async ({ id, revision }) => {
    const row = await db.get(id);
    if (!row || !heldKeys.has(row.scope_key)) return { id, revision, revoked: true as const };
    return { id, revision: row.delivered_revision, scope_key: row.scope_key, position: row.position };
  }));
}

export const getReceipts = query({
  args: { receipts: v.array(v.object({ id: v.id("sync_outbox"), revision: v.number() })) },
  handler: async (ctx, { receipts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return readDeliveryReceipts(ctx.db, receipts, new Set(await heldKeysFor(ctx, userId)));
  },
});
