import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";

// A slice of the received body long enough to be unique in the sender's
// transcript, short enough to survive any reformatting between the two
// transcripts. Whitespace is normalized on the server, on both sides.
export function sendingExcerpt(body: string): string {
  return (body ?? "").trim().slice(0, 240);
}

// Open the message that SENT this one. A card that names another session can
// only open that session, which drops the reader at its tail — usually hours of
// unrelated work after the send. The server locates the turn the text was
// written in (sessionThreads.findSendingMessage) and the thread scrolls there.
// When the turn can't be named the session still opens, so the link never dies.
// `sender` is whatever the card had: a conversation id or a 7-char short id.
export function useJumpToSendingMessage(
  sender: string | undefined,
  deliveredAt: number | undefined,
  body: string,
): () => Promise<boolean> {
  const convex = useConvex();
  return useCallback(async () => {
    if (!sender) return false;
    const found = deliveredAt
      ? await convex
          .query(api.sessionThreads.findSendingMessage, {
            sender,
            delivered_at: deliveredAt,
            excerpt: sendingExcerpt(body),
          })
          .catch(() => null)
      : null;
    const conversationId = found?.conversation_id ?? (isConvexId(sender) ? sender : null);
    if (!conversationId) return false;
    useInboxStore.getState().requestNavigate(conversationId, {
      scrollToMessageId: found?.message_id ?? null,
      scrollToMessageTimestamp: found?.timestamp ?? null,
    });
    return true;
  }, [sender, deliveredAt, body, convex]);
}
