import { useCallback } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { AgentStatus } from "@codecast/shared/contracts";

// The session controls a composer drives, shared by every surface that shows
// a session's full composer (the conversation view, a Threads card): the
// session row's live fields, the agent status the composer should believe,
// and the Escape that interrupts the agent.

export { useManagedSessionFields } from "./useManagedSessionFields";

/** What the composer is told about the agent: a parked session says so; a
 *  disconnected or ended one says nothing (its row's status is stale). */
export function composerAgentStatus(
  agentStatus: string | undefined,
  o: { active: boolean; disconnected: boolean },
): AgentStatus | undefined {
  if (agentStatus === "hibernated") return "hibernated";
  if (o.disconnected || !o.active) return undefined;
  return agentStatus as AgentStatus | undefined;
}

/** Escape to the agent (interrupt). The daemon judges whether the agent is
 *  mid-turn (cli/src/escapeInterrupt.ts); the press time rides along so an
 *  Escape aimed at the previous turn cannot cancel the one a queued message
 *  started after it. Returns whether the press was sent. */
export function useSessionEscape(
  conversationId: string | undefined,
  o: { active: boolean; isOwner: boolean },
): () => boolean {
  const convCommand = useInboxStore((s) => s.convCommand);
  return useCallback(() => {
    if (!conversationId || !o.isOwner || !o.active) return false;
    void convCommand(conversationId as Id<"conversations">, "sendEscapeToSession", { pressed_at: Date.now() }).catch((err) => {
      if (isParkedDispatchError(err)) {
        toast.info("Escape queued — it will send when the connection recovers");
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to send Escape");
    });
    return true;
  }, [conversationId, o.isOwner, o.active, convCommand]);
}
