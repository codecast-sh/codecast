import { useInboxStore } from "../store/inboxStore";

/** This conversation's ask that was said yes to and is still running: its
 *  line holds the card's place until the answer lands with the result. */
export function useRunningPermission(conversationId: string | undefined): { id: string; question: string } | null {
  const id = useInboxStore((s) => {
    if (!conversationId) return null;
    for (const d of Object.values(s.sessionDecisions)) {
      if (d.conversation_id === conversationId && (d.run?.state === "queued" || d.run?.state === "running")) return String(d._id);
    }
    return null;
  });
  const question = useInboxStore((s) => (id ? s.sessionDecisions[id]?.question ?? "" : ""));
  return id === null ? null : { id, question };
}
