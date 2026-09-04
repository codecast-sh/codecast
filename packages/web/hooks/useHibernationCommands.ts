import { useCallback, useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { useSyncCollection } from "./useSyncCollection";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { recordHibernationDispatchError } from "../lib/hibernation";
import { captureException } from "@sentry/react";

const sig = (row: any) => `${row.command_id ?? ""}|${row.conversation_id}|${row.requested_at}|${row.executed_at}|${row.result}|${row.error}`;

export function useHibernationCommands() {
  const commands = useCollectionRows<any>("sessionCommands", { sig });
  const requestIds = commands.filter(c => !c.executed_at).map(c => c._id).sort().slice(0, 100).join(",");
  const args = useMemo(() => requestIds ? { request_ids: requestIds.split(",") } : "skip", [requestIds]);
  const { error } = useSyncCollection("sessionCommands", (api as any).sessionCommands.results, args);
  const request = useCallback((conversationId: string, sessionId: string, ownerDeviceId: string) => {
    const requestId = crypto.randomUUID();
    const store = useInboxStore.getState();
    void store.hibernateSession(requestId, conversationId, sessionId, ownerDeviceId).catch(error => {
      if (isParkedDispatchError(error)) return;
      captureException(error);
      recordHibernationDispatchError(requestId, error);
    });
    return requestId;
  }, []);
  return { commands, request, error };
}
