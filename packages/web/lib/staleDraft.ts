// A persisted draft that is byte-identical to a user message already sent in
// the conversation is residue, not input — historically left behind when a
// fork-rewrite preview (Alt+J/K message selection) was captured by the draft
// snapshot on navigation, or when a send raced the draft debounce. Refusing it
// at restore time stops old messages from resurrecting in the composer.
//
// The length floor keeps deliberate re-sends alive: short drafts like
// "continue" or "yes" legitimately match earlier messages and are never
// treated as stale.
export const STALE_DRAFT_MIN_LENGTH = 40;

type SentMessage = { role: string; content?: string };

export function isResentCopyOfSentMessage(
  messages: readonly SentMessage[] | undefined,
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < STALE_DRAFT_MIN_LENGTH) return false;
  if (!messages?.length) return false;
  return messages.some(
    (m) =>
      (m.role === "user" || m.role === "human") &&
      typeof m.content === "string" &&
      m.content.trim() === t,
  );
}
