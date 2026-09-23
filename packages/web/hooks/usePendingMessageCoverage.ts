import { useRef } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { queryWithSignal } from "../lib/queryWithSignal";
import { useRecoveryPoll } from "./useRecoveryPoll";
import { reconcilePendingMessageCoverage } from "./pendingMessageCoverage";

export function usePendingMessageCoverage() {
  const client = useConvex();
  const lastCheck = useRef(0);
  useRecoveryPoll(lastCheck, async signal => {
    const state = useInboxStore.getState();
    const userId = state.currentUser?._id;
    if (!userId || !client.connectionState().isWebSocketConnected) return;
    await reconcilePendingMessageCoverage({
      pending: state.pendingMessages,
      query: (conversationId, commandIds) => queryWithSignal(client, api.messages.getMessageCoverageV2, {
        conversation_id: conversationId as any,
        command_ids: commandIds,
      }, signal),
      // Settle, never remove: the server holding the row does not mean this
      // window's tail has it yet. The bubble stays until the echo lands.
      settle: (conversationId, commandIds) => {
        for (const clientId of commandIds) useInboxStore.getState().settleOptimisticMessage(conversationId, clientId);
      },
      fail: (conversationId, commandIds) => {
        for (const clientId of commandIds) useInboxStore.getState().markOptimisticAsFailed(conversationId, clientId);
      },
      isCurrent: () => !signal.aborted && useInboxStore.getState().currentUser?._id === userId,
    });
    lastCheck.current = Date.now();
  }, 60_000);
}
