// Cancel a send that has not reached its session, from any surface that
// offers it (the composer's stuck-send banner, a pending bubble's menu, the
// shared queue). Only an answer that the text was taken back returns it to
// the session's composer (when the composer is empty), so sending it again,
// or changing it first, is one step. Every other answer (delivered,
// injected, unconfirmed, a status the cancel lost a race to, or a send the
// server could not find by its client id, which may still be on its way)
// means the agent may already hold it or still get it, and the person is told
// so instead of seeing the text come back as if withdrawn. A thrown refusal
// ("already being delivered") reaches the caller, which shows it.
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";

/** The cancel took the message back: "cancelled", or no row under the server id it named. */
export function cancelTookItBack(status: string, ref: { messageId?: string; clientId?: string }): boolean {
  return status === "cancelled" || (status === "not_found" && !!ref.messageId);
}

export async function cancelPendingSend(conversationId: string, ref: { messageId?: string; clientId?: string }, content: string | null | undefined): Promise<string> {
  const store = useInboxStore.getState();
  const status = await store.cancelPendingMessage(conversationId, ref);
  if (!cancelTookItBack(status, ref)) toast.info("This message may already have reached the session");
  else if (status === "cancelled" && content?.trim()) store.setComposerPrefill({ convId: conversationId, text: content });
  return status;
}
