// Cancel a send that has not reached its session, from any surface that
// offers it (the composer's stuck-send banner, a pending bubble's menu, the
// shared queue). Only a "cancelled" answer means the text was taken back:
// then it returns to the session's composer when the composer is empty, so
// sending it again, or changing it first, is one step. Every other answer
// except "not_found" (delivered, injected, unconfirmed, a status the cancel
// lost a race to) means the agent may already hold it, and the person is
// told so instead of seeing the text come back as if withdrawn.
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";

export function cancelReachedSession(status: string): boolean {
  return status !== "cancelled" && status !== "not_found";
}

export async function cancelPendingSend(conversationId: string, ref: { messageId?: string; clientId?: string }, content: string | null | undefined): Promise<string> {
  const store = useInboxStore.getState();
  const status = await store.cancelPendingMessage(conversationId, ref);
  if (cancelReachedSession(status)) toast.info("This message may already have reached the session");
  else if (status === "cancelled" && content?.trim()) store.setComposerPrefill({ convId: conversationId, text: content });
  return status;
}
