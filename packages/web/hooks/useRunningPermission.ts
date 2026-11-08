import { useInboxStore } from "../store/inboxStore";

/** This conversation's ask that was said yes to and is still running: its
 *  line holds the card's place until the answer lands with the result. */
export function useRunningPermission(conversationId: string | undefined): { question: string } | null {
  const question = useInboxStore((s) => {
    if (!conversationId) return null;
    for (const d of Object.values(s.sessionDecisions)) {
      if (d.conversation_id === conversationId && (d.run?.state === "queued" || d.run?.state === "running")) return d.question;
    }
    return null;
  });
  return question === null ? null : { question };
}
