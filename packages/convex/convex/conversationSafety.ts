import { classifyApiErrorBanner } from "@codecast/shared/contracts";

export type ConversationSafetyState = {
  pending_api_error_kind?: string | null;
  pending_api_error_at?: number | null;
  session_error?: string | null;
};

export function isConversationSafetyBlocked(conversation: ConversationSafetyState): boolean {
  return conversation.pending_api_error_kind === "safety"
    || classifyApiErrorBanner(conversation.session_error ?? undefined) === "safety";
}

export function safetyBlockPatch(
  conversation: ConversationSafetyState,
  messages: readonly { role: string; content?: string; timestamp?: number }[],
  now: number,
) {
  const first = messages
    .filter((message) => message.role === "assistant" && classifyApiErrorBanner(message.content) === "safety")
    .reduce<typeof messages[number] | undefined>((earliest, message) =>
      !earliest || (message.timestamp ?? now) < (earliest.timestamp ?? now) ? message : earliest, undefined);
  if (!first && !isConversationSafetyBlocked(conversation)) return undefined;
  const error = classifyApiErrorBanner(conversation.session_error ?? undefined) === "safety"
    ? conversation.session_error! : first?.content;
  return {
    pending_api_error: true,
    pending_api_error_kind: "safety" as const,
    pending_api_error_at: conversation.pending_api_error_kind === "safety"
      ? conversation.pending_api_error_at ?? first?.timestamp ?? now
      : first?.timestamp ?? now,
    ...(error ? { session_error: error } : {}),
  };
}
