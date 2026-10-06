import { internal } from "./_generated/api";
import {
  buildCargo, cargoBytes, CARGO_MAX_BYTES, isLifecycleEntity, mergeCargo, payloadsDisabled,
  type ActionExtra, type LifecycleEntity, type SyncAckCollector, type SyncOp,
} from "./syncLog";
import type { ChangeEntity } from "./changeLog";

export function attachSyncOutbox(ctx: any, collector: SyncAckCollector): void {
  collector.receipts = [];
  collector.enqueue = async (scopeKey, entityType, entityId, op, extra) => {
    const receipt = await enqueueSyncAction(ctx, scopeKey, entityType, entityId, op, extra);
    const existing = collector.receipts!.find((r) => r.id === receipt.id);
    if (existing) existing.revision = receipt.revision;
    else collector.receipts!.push(receipt);
  };
}

export async function enqueueSyncAction(
  ctx: any, scopeKey: string, entityType: ChangeEntity | LifecycleEntity,
  entityId: string, op: SyncOp, extra: ActionExtra = {},
) {
  const existing = await ctx.db.query("sync_outbox")
    .withIndex("by_scope_entity", (q: any) => q.eq("scope_key", scopeKey).eq("entity_id", entityId))
    .unique();
  const revision = (existing?.revision ?? 0) + 1;
  let cargo;
  let access;
  let events;
  if (isLifecycleEntity(entityType)) {
    events = [...(existing?.events ?? []), { op, revision }];
  } else if (op === "upsert") {
    const doc = extra.fullDoc ? await extra.fullDoc() : null;
    const incoming = doc && extra.table && !payloadsDisabled()
      ? { ...buildCargo(extra.table, doc, { full: true }), unset: extra.cargo?.unset, omitted: extra.cargo?.omitted }
      : extra.cargo ?? { partial: true };
    cargo = mergeCargo(existing?.pending && existing.op === "upsert" ? existing.cargo : null, incoming);
    if (cargoBytes(cargo) > CARGO_MAX_BYTES) cargo = { partial: true, omitted: cargo.omitted };
    access = extra.access ? await extra.access() : undefined;
  }
  const fields = {
    scope_key: scopeKey, entity_type: entityType, entity_id: entityId,
    revision, pending: true, updated_at: Date.now(), op, cargo, access, events,
  };
  const id = existing?._id ?? await ctx.db.insert("sync_outbox", {
    ...fields, delivered_revision: 0, position: 0,
  });
  if (existing) await ctx.db.patch(id, fields);
  if (!existing?.pending) await ctx.scheduler.runAfter(25, (internal as any).syncOutbox.drain, { id });
  return { id: String(id), revision, scope_key: scopeKey, entity_type: entityType, entity_id: entityId };
}
