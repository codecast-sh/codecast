import { useTrackedStore, placeInboxRows } from "../store/inboxStore";
import { rowSigExcluding } from "../store/wakeSig";
import { useCoarseNow } from "./useCoarseNow";

const LIVENESS_FIELDS = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at"]);

/**
 * Whether the rail draws this conversation in the sections the Dormant split
 * makes (Working by its own work, Shipping, Sleeping: placeInboxRows' dormant
 * list, the bucket plus a wait the viewer cannot answer). There the header's
 * activity chip (DormantWakeChip) says the state, so nothing else in the
 * header says one. Read off the panel's own placement, so it lands on its memo.
 */
export function useDrawnInSplit(conversationId: string | undefined): boolean {
  const s = useTrackedStore([
    (st) => (conversationId ? rowSigExcluding(st.sessions[conversationId], LIVENESS_FIELDS) : null),
    (st) => st.currentUser?._id,
  ]);
  const now = useCoarseNow(30_000);
  if (!conversationId || !s.sessions[conversationId]) return false;
  return placeInboxRows(s, { focusedId: s.currentSessionId ?? null, now }).dormant.some((r) => r._id === conversationId);
}
