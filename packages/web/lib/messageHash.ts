// The `#msg-<id>` fragment that deep links to a message, optionally narrowed
// to one paragraph (quote unit, see lib/quoteUnits) as `#msg-<id>.p<n>`, n
// counting from 1. Every reader of the fragment goes through parseMessageHash
// so the paragraph suffix never leaks into a message id lookup.

export function formatMessageHash(messageId: string, block?: number): string {
  return `#msg-${messageId}${block != null ? `.p${block + 1}` : ""}`;
}

/** Parses `#msg-<id>` or `#msg-<id>.p<n>` (also without the leading `#`).
 *  `block` is the zero-based quote unit index. */
export function parseMessageHash(hash: string): { messageId: string; block?: number } | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h.startsWith("msg-")) return null;
  const rest = h.slice(4);
  const m = rest.match(/^(.+)\.p(\d+)$/);
  if (m && Number(m[2]) >= 1) return { messageId: m[1], block: Number(m[2]) - 1 };
  return rest ? { messageId: rest } : null;
}
