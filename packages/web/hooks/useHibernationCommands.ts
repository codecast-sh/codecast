import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { newRequestId, recordSessionCommandDispatchError } from "../lib/sessionCommands";
import { useSessionCommandResults } from "./useSessionCommands";
import { captureException } from "@sentry/react";

const sig = (row: any) => `${row.command_id ?? ""}|${row.conversation_id}|${row.requested_at}|${row.executed_at}|${row.result}|${row.error}`;

export function useHibernationCommands() {
  const commands = useCollectionRows<any>("sessionCommands", { sig });
  const { error } = useSessionCommandResults();
  const request = useCallback((conversationId: string, sessionId: string, ownerDeviceId: string) => {
    const requestId = newRequestId();
    const store = useInboxStore.getState();
    void store.hibernateSession(requestId, conversationId, sessionId, ownerDeviceId).catch(error => {
      if (isParkedDispatchError(error)) return;
      captureException(error);
      recordSessionCommandDispatchError(requestId, error);
    });
    return requestId;
  }, []);
  return { commands, request, error };
}
