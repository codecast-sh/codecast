// Parser for the session→session message wrapper produced by `cast send`.
// The wire format is defined server-side by formatSessionMessage in
// packages/convex/convex/pendingMessages.ts — keep the tag name in sync.
//
//   <session-message from="jx7c6zk">
//   the body
//   </session-message>

const SESSION_MESSAGE_RE = /<session-message\s+from="([^"]*)"[^>]*>([\s\S]*?)<\/session-message>/;

export function parseSessionMessage(text: string): { from: string; body: string } | null {
  if (!text || typeof text !== "string") return null;
  const match = text.match(SESSION_MESSAGE_RE);
  if (!match) return null;
  return { from: match[1].trim(), body: match[2].trim() };
}

// Mirror of the server-side formatter, for any client that wants to construct one
// (and for round-trip tests).
export function formatSessionMessage(fromShortId: string, body: string): string {
  return `<session-message from="${fromShortId}">\n${body}\n</session-message>`;
}
