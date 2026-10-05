// Starting a conversation with the hosted assistant from the simple lane.
// The same optimistic create every new-session entry point uses
// (inboxStore.beginOptimisticSession): the stub row and the person's first
// message render at once, and the store's createSession action (its dispatch
// side effect runs the hosted start for a hosted agent) makes the real row
// with the stub's id as its session_id, so the store's resolver maps one onto
// the other when it syncs. The first message rides the create itself
// (first_message_client_id is the optimistic bubble's client id), so the
// server queues it in the same transaction and the two reconcile.
import { useCallback } from "react";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useInboxStore } from "../../store/inboxStore";

/** Seeds the stub and fires the create; returns the stub id to navigate to.
 *  `resumeStubId` re-fires a stub whose create failed (its row is reused). */
export function startConversationWith(text: string, resumeStubId?: string): string {
  const store = useInboxStore.getState();
  let clientId = "";
  const { stubId, materialize } = store.beginOptimisticSession({
    agentType: HOSTED_AGENT_TYPE,
    deferCreate: true,
    resumeStubId,
    create: (sid) =>
      useInboxStore.getState()
        .createSession({ agent_type: HOSTED_AGENT_TYPE, session_id: sid, first_message: text, first_message_client_id: clientId })
        .then((id: unknown) => String(id)),
  });
  clientId = store.addOptimisticMessage(stubId, text);
  materialize().catch((error) => {
    // A refused create leaves the bubble marked so the conversation offers
    // to try again (retryConversationStart).
    useInboxStore.getState().markOptimisticAsFailed(stubId, clientId);
    console.error("[simple] could not start the conversation", error);
  });
  return stubId;
}

/** The lane's "start a conversation" gesture. */
export function useStartConversation(): (text: string) => string {
  return useCallback((text: string) => startConversationWith(text), []);
}

/** Tries a failed start again: the failed bubble goes, the stub is reused. */
export function useRetryConversationStart(): (stubId: string, clientId: string, text: string) => void {
  return useCallback((stubId: string, clientId: string, text: string) => {
    useInboxStore.getState().removeOptimisticMessage(stubId, clientId);
    startConversationWith(text, stubId);
  }, []);
}
