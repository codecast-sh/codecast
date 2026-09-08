// "The reader is here, looking at this session." The one writer of
// acknowledged_at.
//
// Three conditions, all required, none of them mere mount:
//   - a conversation is the ACTIVE view (not a background tab pane, not a
//     session merely held in the store),
//   - the reader is PRESENT — window focused, document visible, this tab pane
//     on screen (usePagePresence, the same gate chat and the Threads page use),
//   - the session has MOVED since the last mark (updated_at past the ack).
//
// The effect's dependency list is the whole re-ack rule, which is why there is
// no timer and no hold flag here. It re-runs when the conversation changes
// (you arrived) or when updated_at advances (a new turn landed while you
// watched) — and NOT when the read mark itself changes. That is what lets
// "mark unread" survive: the gesture flips manual_unread without touching
// either dependency, so nothing re-acks until you leave and come back.
import { sessionActivityAt, shouldAcknowledge } from "@codecast/shared/contracts";
import { sessionActivityFacts, useInboxStore } from "../store/inboxStore";
import { usePagePresence } from "./usePagePresence";
import { useWatchEffect } from "./useWatchEffect";

export function useAckActiveConversation(conversationId: string | null | undefined): void {
  const present = usePagePresence();
  // A ConversationView also renders for the side panel and for panes the
  // reader is not on; only the session the shell says is current counts as
  // being read.
  const isCurrent = useInboxStore((s) => !!conversationId && s.currentSessionId === conversationId);
  // The moment the card compares the mark against — the last turn ending, or
  // the row's activity watermark when no turn stamp exists. Acknowledging
  // exactly this number is what makes the dot go out without a round trip, and
  // what keeps the server echo from re-lighting the card.
  const updatedAt = useInboxStore((s) => {
    if (!conversationId) return 0;
    const row = s.sessions[conversationId] ?? s.conversations[conversationId];
    return sessionActivityAt(sessionActivityFacts(row as any));
  });

  useWatchEffect(() => {
    if (!shouldAcknowledge({ conversationId, isActiveView: isCurrent, present, updatedAt })) return;
    useInboxStore.getState().ackSessionRead(conversationId!, updatedAt);
  }, [conversationId, isCurrent, present, updatedAt]);
}
