import { useConversationMessages } from "../hooks/useConversationMessages";

export function SessionPrewarm({ sessionId }: { sessionId: string }) {
  useConversationMessages(sessionId);
  return null;
}
