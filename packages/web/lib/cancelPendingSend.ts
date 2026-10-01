// Cancel a send that has not reached its session, from any surface that
// offers it (the composer's stuck-send banner, a pending bubble's menu). The
// text comes back into the session's composer when the composer is empty, so
// sending it again, or changing it first, is one step: a cancelled message
// is otherwise gone from the page.
import { useInboxStore } from "../store/inboxStore";

export async function cancelPendingSend(conversationId: string, ref: { messageId?: string; clientId?: string }, content: string | null | undefined): Promise<string> {
  const store = useInboxStore.getState();
  const status = await store.cancelPendingMessage(conversationId, ref);
  // Already in the session: nothing was taken back.
  if (content?.trim() && status !== "delivered" && status !== "injected") store.setComposerPrefill({ convId: conversationId, text: content });
  return status;
}
