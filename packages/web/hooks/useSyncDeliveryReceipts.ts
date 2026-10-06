import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, syncLogScopeMetaKey } from "../store/inboxStore";
import { deliveryReceiptIds, settleDeliveryReceipts } from "../lib/syncDeliveryReceipts";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

export function useSyncDeliveryReceipts() {
  const idsJson = useInboxStore((s) => JSON.stringify(deliveryReceiptIds(s.pending)));
  const cursorSig = useInboxStore((s) => Object.entries(s.syncMeta)
    .filter(([key]) => key.startsWith("synclog:v1:"))
    .map(([key, value]) => `${key}:${value.cursor ?? 0}`).sort().join("|"));
  const ids = JSON.parse(idsJson);
  const { data } = useQueryNoThrow((api as any).syncOutbox.getReceipts, ids.length ? { ids } : "skip");
  useWatchEffect(() => {
    if (Array.isArray(data)) settleDeliveryReceipts(useInboxStore.getState(), data, syncLogScopeMetaKey);
  }, [data, cursorSig, idsJson]);
}
