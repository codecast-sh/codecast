export const DELIVERY_SCOPE_PREFIX = "outbox:";

type Receipt = { id: string; revision: number; entity_type: string; entity_id: string };
type Delivery = { id: string; revision?: number; scope_key?: string; position?: number; revoked?: boolean };

export function stampDeliveryReceipts(store: any, patches: any, receipts: Receipt[], sentAt: number) {
  if (!patches || !Array.isArray(receipts)) return;
  const groups = new Map<string, Receipt[]>();
  for (const receipt of receipts) {
    const key = `${receipt.entity_type}:${receipt.entity_id}`;
    groups.set(key, [...(groups.get(key) ?? []), receipt]);
  }
  for (const group of groups.values()) {
    const receipt = group[0];
    const fields = patches[receipt.entity_type]?.[receipt.entity_id];
    if (!fields) continue;
    store.stampSyncAck(
      { [receipt.entity_type]: { [receipt.entity_id]: fields } },
      group.map((r) => ({ scope_key: DELIVERY_SCOPE_PREFIX + r.id, position: r.revision })), sentAt,
    );
  }
}

export function deliveryReceiptIds(pending: Record<string, any>): string[] {
  return deliveryReceiptRequests(pending).map((r) => r.id);
}

export function deliveryReceiptRequests(pending: Record<string, any>) {
  const revisions = new Map<string, number>();
  for (const entry of Object.values(pending)) {
    for (const ack of entry?.ack ?? []) {
      if (typeof ack.s !== "string" || !ack.s.startsWith(DELIVERY_SCOPE_PREFIX)) continue;
      const id = ack.s.slice(DELIVERY_SCOPE_PREFIX.length);
      revisions.set(id, Math.max(revisions.get(id) ?? 0, ack.p));
    }
  }
  return [...revisions].sort(([a], [b]) => a.localeCompare(b)).slice(0, 100)
    .map(([id, revision]) => ({ id, revision }));
}

export function settleDeliveryReceipts(store: any, deliveries: Delivery[], metaKey: (scope: string) => string) {
  for (const delivery of deliveries) {
    if (delivery.revoked) {
      store.retireAckedPending(DELIVERY_SCOPE_PREFIX + delivery.id, delivery.revision ?? 0);
    } else if (delivery.scope_key && delivery.position &&
      (store.syncMeta[metaKey(delivery.scope_key)]?.cursor ?? 0) >= delivery.position) {
      store.retireAckedPending(DELIVERY_SCOPE_PREFIX + delivery.id, delivery.revision, { restore: true });
    }
  }
}
