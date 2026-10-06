// Which agent a conversation runs on, read from the store (the conversation
// row, or the session row while only that is cached). Surfaces that speak
// differently to a hosted conversation (the assistant, no machine) ask here
// rather than threading the agent type down through their parents.
import { isHostedAgentType } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

/** The conversation's agent type, "claude_code" while the row is not cached. */
export function useConversationAgentType(conversationId: string | undefined): string {
  return useInboxStore(
    (s) => (conversationId ? ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type : undefined) ?? "claude_code",
  );
}

/** Whether the conversation runs on the hosted assistant. */
export function useIsHostedConversation(conversationId: string | undefined): boolean {
  return isHostedAgentType(useConversationAgentType(conversationId));
}
