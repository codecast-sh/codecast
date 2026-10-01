import { useRef } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { queryWithSignal } from "../lib/queryWithSignal";
import { useRecoveryPoll } from "./useRecoveryPoll";
import { reconcilePendingMessageCoverage } from "./pendingMessageCoverage";

type CoverageQuery = Parameters<typeof reconcilePendingMessageCoverage>[0]["query"];

/**
 * One pass of the pending-send coverage poll over the store's bubbles: settle
 * the sends the server holds, fail the ones it refused, and drop a
 * conversation the server deleted. The hook runs it every minute; the sync
 * simulator runs it inside a window's turn.
 */
export function reconcileStorePendingCoverage(query: CoverageQuery, isCurrent: () => boolean) {
  return reconcilePendingMessageCoverage({
    pending: useInboxStore.getState().pendingMessages,
    query,
    // Settle, never remove: the server holding the row does not mean this
    // window's tail has it yet. The bubble stays until the echo lands.
    settle: (conversationId, commandIds) => {
      for (const clientId of commandIds) useInboxStore.getState().settleOptimisticMessage(conversationId, clientId);
    },
    fail: (conversationId, commandIds) => {
      for (const clientId of commandIds) useInboxStore.getState().markOptimisticAsFailed(conversationId, clientId);
    },
    // Deleted server-side (an explicit delete, or the empty GC): drop the
    // cached session rather than holding its unsendable bubbles forever.
    gone: (conversationId) => useInboxStore.getState().pruneGhostSessions([conversationId], { serverDeleted: true }),
    isCurrent,
  });
}

export function usePendingMessageCoverage() {
  const client = useConvex();
  const lastCheck = useRef(0);
  useRecoveryPoll(lastCheck, async signal => {
    const userId = useInboxStore.getState().currentUser?._id;
    if (!userId || !client.connectionState().isWebSocketConnected) return;
    await reconcileStorePendingCoverage(
      (conversationId, commandIds) => queryWithSignal(client, api.messages.getMessageCoverageV2, {
        conversation_id: conversationId as any,
        command_ids: commandIds,
      }, signal),
      () => !signal.aborted && useInboxStore.getState().currentUser?._id === userId,
    );
    lastCheck.current = Date.now();
  }, 60_000);
}
