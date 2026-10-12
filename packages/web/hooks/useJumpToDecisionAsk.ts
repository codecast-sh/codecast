import { useCallback } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { findDecisionAnchorMessage } from "../lib/decisionQueue";
import { isOnThreadRoute, openSessionAtMessage } from "../lib/openSessionAtMessage";
import { shouldUseTabRouting, tabNavigate } from "../src/compat/tabRouting";

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

// Scroll the thread to the ask itself: the `cast decide` call rendered in the
// transcript. The anchor is found locally when the message is loaded; when the
// ask is older than the loaded window, the server locates it by the decision
// id, which the CLI printed into the call's output (findAskMessage). Shared by
// the decision card ("asked 2h ago"), the answer bubble ("the ask"), and the
// decision page's conversation link, so every surface jumps the same way.
// Opens the conversation even when the ask message cannot be named. The
// org screen scrolls its embedded thread to the same message (locateDecisionAsk).
export function useJumpToDecisionAsk(
  conversationId: string | undefined,
  decisionId: string | undefined,
  question: string,
): () => Promise<boolean> {
  const convex = useConvex();
  return useCallback(async () => {
    if (!conversationId) return false;
    const target = await locateDecisionAsk(convex, conversationId, decisionId, question);
    openSessionAtMessage(conversationId, target?.id ?? null, target?.ts ?? null);
    if (!isOnThreadRoute()) {
      const dest = target ? `/conversation/${conversationId}#msg-${target.id}` : `/inbox?s=${conversationId}`;
      if (shouldUseTabRouting(dest)) tabNavigate(dest, "push");
      else if (typeof window !== "undefined") window.location.assign(dest);
    }
    return true;
  }, [conversationId, decisionId, question, convex]);
}
