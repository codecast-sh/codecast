// A hosted conversation's turn runs in the backend, woken through Convex's
// scheduler, which can run minutes behind. So right after a write gives a
// hosted conversation input, the client asks the backend to run the turn now
// (assistant/entry.ts kick). The scheduled wake stays the fallback, and the
// turn's claim (turns.ts begin) lets only one of the two run it.
// Relative imports only: mobile reaches this file.
import type { DispatchFn } from "@platform/engine";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { isConvexId, useInboxStore } from "../store/inboxStore";

/** The dispatch actions that give a conversation input, with where each
 *  names it: the conversation id argument, or (a create) its result. */
const INPUT_ACTIONS: Record<string, (args: any, result: unknown) => unknown> = {
  createSession: (args, result) => (isHostedAgentType(args?.[0]?.agent_type) ? result : undefined),
  sendMessage: (args) => args?.[0],
  releaseQueued: (args) => args?.[0],
  retryPendingMessage: (args) => args?.[0],
};

/** The hosted conversation a landed dispatch gave input to, if any. */
export function hostedKickTarget(action: string, args: unknown, result: unknown): string | null {
  const id = INPUT_ACTIONS[action]?.(args, result);
  if (typeof id !== "string" || !isConvexId(id)) return null;
  if (action === "createSession") return id;
  const s = useInboxStore.getState();
  const row = s.sessions[id] ?? s.conversations[id];
  return isHostedAgentType(row?.agent_type) ? id : null;
}

/** Wraps the store's dispatch so every write that lands with input for a
 *  hosted conversation kicks its turn. A failed kick changes nothing the
 *  person sees: the scheduled wake still runs the turn. */
export function withHostedKick(dispatch: DispatchFn, kick: (conversationId: string) => Promise<unknown>): DispatchFn {
  return (action, args, patches, result, commandId) =>
    dispatch(action, args, patches, result, commandId).then((landed) => {
      const target = INPUT_ACTIONS[action] ? hostedKickTarget(action, args, landed) : null;
      if (target) kick(target).catch((error) => console.warn("[assistant] kick failed; the scheduled wake runs the turn", error));
      return landed;
    });
}
