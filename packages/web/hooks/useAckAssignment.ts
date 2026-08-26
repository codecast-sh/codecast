"use client";

/**
 * Ack a handoff from any surface WITHOUT a listOwners subscription — inbox
 * cards use this so hundreds of rows don't each open a live query. Clears the
 * row's assigned ping local-first, then stamps seen_at on the server (the
 * mutation is idempotent and a no-op for non-owners).
 *
 * MOBILE-SAFE by construction (bundled into the Expo app): no DOM, no sonner —
 * see the shared-code Hermes traps. Both the web and mobile inbox pills go
 * through here; the in-conversation banners keep useOwners' ack (they need its
 * ackedLocally to hide instantly off the live listOwners query).
 */

import { useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { isConvexId } from "../lib/entityLinks";

export function useAckAssignment() {
  const ackAssignment = useMutation(api.sessionOwnership.ackSessionAssignment);
  return useCallback(
    (conversationId: string) => {
      useInboxStore.getState().clearAssignedPing(conversationId);
      if (isConvexId(conversationId)) ackAssignment({ session_id: conversationId }).catch(() => {});
    },
    [ackAssignment],
  );
}
