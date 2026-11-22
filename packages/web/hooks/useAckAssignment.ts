"use client";

/**
 * Ack a handoff from any surface WITHOUT a listOwners subscription — inbox
 * cards use this so hundreds of rows don't each open a live query. The store's
 * ackSessionAssignment clears the row's assigned ping local-first and stamps
 * seen_at on the server (idempotent, a no-op for non-owners).
 *
 * MOBILE-SAFE by construction (bundled into the Expo app): no DOM, no sonner —
 * see the shared-code Hermes traps. Both the web and mobile inbox pills go
 * through here; the in-conversation banners call the same store action.
 */

import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";

export function useAckAssignment() {
  return useCallback((conversationId: string) => {
    if (isConvexId(conversationId)) useInboxStore.getState().ackSessionAssignment(conversationId);
    else useInboxStore.getState().clearAssignedPing(conversationId);
  }, []);
}
