import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { quoteDraftsOn, uploadQuoteBatches } from "../lib/quoteDraftWire";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useWatchEffect } from "./useWatchEffect";

// The batch was saved to the server once this page load (uploadQuoteBatches).
let uploaded = false;

/**
 * Mount once per open conversation: feed the viewer's quote records for it
 * into the store (convex quoteDrafts.listForConversation), so the review rail
 * can show a sent quote as sent, then answered. Nothing runs unless the
 * person turned the quote record on. The first mount with it on also saves
 * whatever quotes were already waiting in the batch, from before it was on.
 */
export function useSyncQuoteDrafts(conversationId: string | undefined): void {
  const on = useInboxStore(quoteDraftsOn);
  // Each answer is every record of this conversation: one it lacks was removed.
  const dropAbsent = useCallback((row: { conversation_id?: string | null }) => row.conversation_id === conversationId, [conversationId]);
  useSyncCollection(
    "quoteDrafts",
    api.quoteDrafts.listForConversation,
    on ? (entityIdArgs("conversation_id", conversationId) as { conversation_id: any } | "skip") : "skip",
    { dropAbsent },
  );
  useWatchEffect(() => {
    if (!on || uploaded) return;
    uploaded = true;
    uploadQuoteBatches(useInboxStore.getState());
  }, [on]);
}
