import { useInboxStore } from "../store/inboxStore";

/** Send a message into a session the way a composer does: the bubble paints
 *  at once (an optimistic row under a client id) and the send dispatches
 *  under the same id, so the server's echo retires the bubble. */
export function sendToSession(conversationId: string, content: string, imageIds?: string[]): void {
  const s = useInboxStore.getState();
  const clientId = s.addOptimisticMessage(conversationId, content);
  s.sendMessage(conversationId, content, imageIds?.length ? imageIds : undefined, clientId);
}
