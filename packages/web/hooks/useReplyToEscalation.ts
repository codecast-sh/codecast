import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { QueueItem } from "../lib/decisionQueue";

// The one way a person answers a role's escalation (org-roles-run-work.md R1,
// revised): a reply in words to the card's session (the role's standing
// session, or the child itself when direct), and the session is the role's
// again in the same tick. The role holds the context and relays; the hand
// back writes the "back with @role" divider into both threads, so the move is
// visible where the work is. Shared by the sheet and the queue's card, so
// the two cannot answer differently.
export function useReplyToEscalation() {
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const handSessionBackToRole = useInboxStore((s) => s.handSessionBackToRole);
  return useCallback((item: QueueItem, text: string): boolean => {
    const esc = item.escalation;
    const trimmed = text.trim();
    if (!esc || !trimmed) return false;
    // The role's thread can carry several asks: name the session this one is about.
    const childTitle = useInboxStore.getState().sessions[esc.childId]?.title;
    const content = esc.childId === item.conversationId ? trimmed : `Re: ${childTitle || "the session you escalated"}\n\n${trimmed}`;
    const clientId = addOptimisticMessage(item.conversationId, content);
    sendMessage(item.conversationId, content, undefined, clientId);
    handSessionBackToRole(esc.childId);
    return true;
  }, [addOptimisticMessage, sendMessage, handSessionBackToRole]);
}
