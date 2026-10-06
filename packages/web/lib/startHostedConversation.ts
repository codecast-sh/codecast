// Starting a conversation with the hosted assistant (the Codecast assistant)
// from a surface that holds only the text: the command palette's "Ask the
// Codecast assistant", /welcome's first result, the phone. The same optimistic
// create every new-session entry point uses (inboxStore.beginOptimisticSession):
// the stub row and the person's first message render at once, and
// createSessionFromStub makes the real row with the stub's id as its
// session_id, the first message riding the create itself
// (first_message_client_id is the optimistic bubble's client id) so the server
// queues it in the same transaction and the two reconcile. The compose popup
// reaches the same create through its own stub (ComposeView).
// Relative imports only: mobile reaches this file.
import { useCallback } from "react";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";

/** The one rule for a hosted create that did not land. Only a refused one
 *  (isRefusedDispatchError: the server said no for good, or the write never
 *  reached the outbox) marks the first bubble failed, so the conversation
 *  offers to try again (useRetryHostedStart). Anything else is still queued
 *  and delivers on its own: a parked dispatch, or the stale binding every
 *  cold start on the phone rejects in-flight writes with. `report` shows the reason where the surface has a
 *  way to (the web passes a toast; the phone has none). */
export function settleHostedStart(ready: Promise<unknown>, stubId: string, clientId: string, report?: (message: string) => void): void {
  ready.catch((error) => {
    if (!isRefusedDispatchError(error)) return;
    useInboxStore.getState().markOptimisticAsFailed(stubId, clientId);
    console.error("[assistant] could not start the conversation", error);
    report?.(error instanceof Error ? error.message : "Could not start the conversation");
  });
}

/** Seeds the stub and fires the create; returns the stub id to navigate to.
 *  `resumeStubId` re-fires a stub whose create failed (its row is reused). */
export function startHostedConversation(text: string, resumeStubId?: string): string {
  const store = useInboxStore.getState();
  let clientId = "";
  const { stubId, materialize } = store.beginOptimisticSession({
    agentType: HOSTED_AGENT_TYPE,
    deferCreate: true,
    resumeStubId,
    create: (sid) =>
      useInboxStore.getState()
        .createSessionFromStub(sid, { agentType: HOSTED_AGENT_TYPE, firstMessage: { content: text, clientId } })
        .then((id: unknown) => String(id)),
  });
  clientId = store.addOptimisticMessage(stubId, text);
  settleHostedStart(materialize(), stubId, clientId);
  return stubId;
}

/** The "start a conversation with the assistant" gesture. */
export function useStartHostedConversation(): (text: string) => string {
  return useCallback((text: string) => startHostedConversation(text), []);
}

/** Tries a failed start again: the failed bubble goes, the stub is reused. */
export function useRetryHostedStart(): (stubId: string, clientId: string, text: string) => void {
  return useCallback((stubId: string, clientId: string, text: string) => {
    useInboxStore.getState().removeOptimisticMessage(stubId, clientId);
    startHostedConversation(text, stubId);
  }, []);
}
