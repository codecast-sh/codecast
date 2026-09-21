import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";

/** A standing session's row belongs to the agent's bot user, so the person
 *  who may talk to it is told to the store before the row lands and the owner
 *  UI paints at once. The role page's pane seeds the same way. */
export function useSeedOwnership(conversationId: string, seed: boolean) {
  useWatchEffect(() => {
    if (!seed) return;
    useInboxStore.getState().syncRecord("conversations", conversationId, { _id: conversationId, is_own: true });
  }, [conversationId, seed]);
}
