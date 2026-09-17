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

// After send, a native iOS TextInput can fire onChangeText with the previous
// value (IME composition, blur, a mid-string selection). That is residue, not
// a new thought. The length floor matches STALE_DRAFT_MIN_LENGTH so short
// follow-ups like "continue" are never eaten.
export function isResurrectedComposerText(
  next: string,
  justSent: string | null | undefined,
): boolean {
  if (!justSent) return false;
  const t = next.trim();
  if (!t) return false;
  const sent = justSent.trim();
  if (sent === t) return true;
  if (t.length < STALE_DRAFT_MIN_LENGTH) return false;
  return sent.startsWith(t) || sent.includes(t);
}

// The native box still held the sent text and the user typed more — keep only
// the new suffix. null means this is not that case.
export function composerTextAfterSend(
  next: string,
  justSent: string | null | undefined,
): string | null {
  if (!justSent) return null;
  if (!next.startsWith(justSent)) return null;
  return next.slice(justSent.length).replace(/^\s+/, "");
}
