// Parser for the session→session message wrapper produced by `cast send`.
// The wire format is defined server-side by formatSessionMessage in
// packages/convex/convex/pendingMessages.ts — keep the tag name in sync.
//
//   <session-message from="jx7c6zk">
//   the body
//   </session-message>

const SESSION_MESSAGE_RE = /<session-message\s+from="([^"]*)"[^>]*>([\s\S]*?)<\/session-message>/;
const SESSION_MESSAGE_NAME_RE = /<session-message\s+from="[^"]*"\s+name="([^"]*)"/;

export function parseSessionMessage(text: string): { from: string; body: string; name?: string } | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(SESSION_MESSAGE_RE);
  if (!match) return null;
  const name = text.match(SESSION_MESSAGE_NAME_RE)?.[1]?.trim() || undefined;
  return { from: match[1].trim(), body: match[2].trim(), name };
}

// Normalize the wrappers/control chars the daemon may prepend before the tag.
// A session message is injected via tmux, so the input-clearing keystrokes
// (Ctrl-A/Ctrl-K) occasionally leak in as leading control chars, and
// system/task reminders can be appended by the harness.
function stripInjectionNoise(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^[\x00-\x1f\s]+/, "");
}

// Full parse of an inbound session→session message from a raw user-message
// content string. Use where the complete content is available (classification
// and rendering) and the sender/body are needed.
export function parseInboundSessionMessage(
  rawContent: string | null | undefined,
): { from: string; body: string; name?: string } | null {
  if (!rawContent) return null;
  const cleaned = stripInjectionNoise(rawContent);
  if (!cleaned.startsWith("<session-message")) return null;
  return parseSessionMessage(cleaned);
}

// Lightweight detection that a user message is actually an inbound
// session→session message (delivered by `cast send`). Keys off the OPENING tag
// only, so it still fires on a truncated preview (last_message_preview is
// sliced to 200 chars, which can drop the closing tag). Surfaces that present
// "what the human said" — the sticky pill, the message navigator, card
// previews — use this to skip these machine-delivered messages.
export function isSessionMessage(rawContent: string | null | undefined): boolean {
  if (!rawContent) return false;
  return /^<session-message\s+from="/.test(stripInjectionNoise(rawContent));
}

// Mirror of the server-side formatter, for any client that wants to construct one
// (and for round-trip tests).
export function formatSessionMessage(fromShortId: string, body: string): string {
  return `<session-message from="${fromShortId}">\n${body}\n</session-message>`;
}
