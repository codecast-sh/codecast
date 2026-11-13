import { useCallback } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId, isSessionHidden } from "../store/inboxStore";
import { findDecisionAnchorMessage } from "../lib/decisionQueue";
import { useOpenSession } from "./useOpenSession";

/** Where a decision was asked: the `cast decide` call's message, found in the
 *  loaded rows or, when it is older than them, by the server from the decision
 *  id. Null when neither names it. */
export async function locateDecisionAsk(
  convex: Pick<ConvexReactClient, "query"> | undefined,
  conversationId: string,
  decisionId: string | undefined,
  question: string,
): Promise<{ id: string; ts: number | null } | null> {
  const anchor = findDecisionAnchorMessage(useInboxStore.getState().messages[conversationId] as any[], decisionId, question);
  if (anchor) return { id: anchor._id, ts: anchor.timestamp ?? null };
  if (!convex || !decisionId || !isConvexId(decisionId)) return null;
  const found = await convex.query(api.sessionDecisions.findAskMessage, { decision_id: decisionId as any }).catch(() => null);
  return found ? { id: found.message_id, ts: found.timestamp } : null;
}

// Open the session that asked, in the inbox, as the selected session, and
// scroll it to the ask itself: the `cast decide` call rendered in the
// transcript. Shared by the decision card ("asked 2h ago"), the answer bubble
// ("the ask"), and the decision page's "Talk to the session", so every surface
// jumps the same way.
//
// The session lands in the inbox and stays there (a hidden row is restored),
// selected, with its composer focused by the inbox conversation.
//
// The switch is local and immediate: it goes through useOpenSession, the same
// path a rail click takes, which commits the session as current in the store
// and routes to /inbox?s=<id> in the same tick. Only the scroll target may
// wait: when the ask is older than the loaded messages, the server locates it
// by the decision id (findAskMessage) and the thread scrolls once it answers,
// provided the viewer is still on that session. The org screen scrolls its
// embedded thread to the same message (locateDecisionAsk).
export function useJumpToDecisionAsk(
  conversationId: string | undefined,
  decisionId: string | undefined,
  question: string,
): () => Promise<boolean> {
  const convex = useConvex();
  const openSession = useOpenSession();
  return useCallback(async () => {
    if (!conversationId) return false;
    // Talking to a session puts it back in the inbox: a stashed, snoozed,
    // dismissed or killed row is restored (the rail's restore gesture), not
    // shown as a peek that is gone once the viewer moves on. A flow station
    // finishes killed, and a killed row is off the list even while open.
    // A nested asker (a flow station) is adopted: it stands alone in the inbox
    // from now on instead of riding a run log nobody lists.
    const store = useInboxStore.getState();
    const row = store.sessions[conversationId];
    if (row && (isSessionHidden(row) || row.inbox_killed_at)) store.restoreSession(conversationId);
    if (row) store.adoptSession(conversationId);
    openSession(conversationId);
    // The ask's message is scrolled to only while the view is on this session:
    // an open diverted elsewhere (a background tab, another window) leaves no
    // stray target for whatever the inbox shows next.
    const scrollTo = (target: { id: string; ts: number | null } | null) => {
      const st = useInboxStore.getState();
      const viewing = st.pendingNavigateId ?? st.viewingDismissedId ?? st.currentSessionId;
      if (target && viewing === conversationId) useInboxStore.setState({ pendingScrollToMessageId: target.id, pendingScrollToMessageTimestamp: target.ts });
    };
    scrollTo(await locateDecisionAsk(convex, conversationId, decisionId, question));
    return true;
  }, [conversationId, decisionId, question, convex, openSession]);
}
