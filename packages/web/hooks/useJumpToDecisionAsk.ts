import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { findDecisionAnchorMessage } from "../lib/decisionQueue";
import { isOnThreadRoute, openSessionAtMessage } from "../lib/openSessionAtMessage";
import { shouldUseTabRouting, tabNavigate } from "../src/compat/tabRouting";

// Scroll the thread to the ask itself: the `cast decide` call rendered in the
// transcript. The anchor is found locally when the message is loaded; when the
// ask is older than the loaded window, the server locates it by the decision
// id, which the CLI printed into the call's output (findAskMessage). Shared by
// the decision card ("asked 2h ago"), the answer bubble ("the ask"), and the
// decision page's conversation link, so every surface jumps the same way.
// Opens the conversation even when the ask message cannot be named.
export function useJumpToDecisionAsk(
  conversationId: string | undefined,
  decisionId: string | undefined,
  question: string,
): () => Promise<boolean> {
  const convex = useConvex();
  return useCallback(async () => {
    if (!conversationId) return false;
    const { messages } = useInboxStore.getState();
    const anchor = findDecisionAnchorMessage(messages[conversationId] as any[], decisionId, question);
    let target = anchor ? { id: anchor._id, ts: anchor.timestamp } : null;
    if (!target && decisionId && isConvexId(decisionId)) {
      const found = await convex
        .query(api.sessionDecisions.findAskMessage, { decision_id: decisionId as any })
        .catch(() => null);
      if (found) target = { id: found.message_id, ts: found.timestamp };
    }
    openSessionAtMessage(conversationId, target?.id ?? null, target?.ts ?? null);
    if (!isOnThreadRoute()) {
      const dest = target ? `/conversation/${conversationId}#msg-${target.id}` : `/inbox?s=${conversationId}`;
      if (shouldUseTabRouting(dest)) tabNavigate(dest, "push");
      else if (typeof window !== "undefined") window.location.assign(dest);
    }
    return true;
  }, [conversationId, decisionId, question, convex]);
}
