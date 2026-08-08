// A persisted draft that duplicates a user message already sent in the
// conversation is residue, not input — historically left behind when a
// fork-rewrite preview (Alt+J/K message selection) was captured by the draft
// snapshot on navigation, or when a send raced the draft debounce. Refusing it
// at restore time stops old messages from resurrecting in the composer.
//
// Two shapes count as residue: byte-identical, and a PREFIX of a sent message
// — the debounce race snapshots mid-typing, so the leftover draft is the text
// as of ~300ms before the send finished it. The reverse (draft longer than a
// sent message it starts with) stays live: that's someone extending an old
// message into new input.
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
  return messages.some((m) => {
    if (m.role !== "user" && m.role !== "human") return false;
    if (typeof m.content !== "string") return false;
    const sent = m.content.trim();
    return sent === t || (sent.length > t.length && sent.startsWith(t));
  });
}
