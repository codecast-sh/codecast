import type { Id } from "./_generated/dataModel";
import type { CommandIdCoverageTarget } from "./localViewRevisions";

export const MESSAGES_VIEW_CONTRACT_ID = "messages.byConversation/v2";

export function messagesViewKey(conversationId: Id<"conversations">): string {
  return `messages:conversation:${conversationId}`;
}

/**
 * Opaque retention/dispatch grant for one authorized conversation message
 * scope. Clients compare and persist this value; they do not parse or mint it.
 */
export function messagesGrantKey(conversationId: Id<"conversations">): string {
  return `messages:conversation-grant:${conversationId}`;
}

export function messagesCommandCoverageTarget(
  conversationId: Id<"conversations">,
): CommandIdCoverageTarget {
  return {
    kind: "command-id",
    contractId: MESSAGES_VIEW_CONTRACT_ID,
    viewKey: messagesViewKey(conversationId),
  };
}
