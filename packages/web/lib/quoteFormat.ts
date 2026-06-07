// Formats quoted text and inline comments into the markdown that gets dropped
// into the composer as the user's next message. A quote becomes a real markdown
// blockquote (`> ...`), which both renders as a quote in the thread and reads as
// a quote to the agent. A comment is that blockquote followed by the user's reply.

export type PendingComment = {
  id: string;
  messageId: string;
  blockIndex: number;
  quote: string;
  body: string;
  createdAt: number;
};

// Prefix every line with "> " so multi-line and structured text (lists, code)
// stay inside one blockquote. Blank lines become a bare ">" to keep the quote
// visually contiguous.
export function toBlockquote(text: string): string {
  const normalized = (text || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";
  const trimmed = normalized.replace(/^\s*\n|\n\s*$/g, "");
  return trimmed
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

// One quote + optional reply body.
export function formatQuotedReply(quote: string, body?: string): string {
  const bq = toBlockquote(quote);
  const reply = (body || "").trim();
  if (bq && reply) return `${bq}\n\n${reply}`;
  return bq || reply;
}

// A batch of inline comments, in the order given, separated by blank lines.
// Comments with no body still emit their quote (treated as a plain quote).
export function formatPendingComments(comments: Pick<PendingComment, "quote" | "body">[]): string {
  return comments
    .map((c) => formatQuotedReply(c.quote, c.body))
    .filter(Boolean)
    .join("\n\n");
}

// Append new text to whatever is already in the composer, keeping one blank line
// between the existing draft and the inserted quote/comment block.
export function appendToDraft(existing: string, addition: string): string {
  const base = (existing || "").replace(/\s+$/, "");
  const add = (addition || "").trim();
  if (!add) return existing || "";
  if (!base) return add;
  return `${base}\n\n${add}`;
}

// Stable ordering for a batch: group by the order each message was first
// commented on, then by block position within a message. Keeps the compiled
// message reading top-to-bottom like the conversation.
export function sortPendingComments(comments: PendingComment[]): PendingComment[] {
  const firstSeen = new Map<string, number>();
  comments.forEach((c) => {
    if (!firstSeen.has(c.messageId)) firstSeen.set(c.messageId, c.createdAt);
  });
  return [...comments].sort((a, b) => {
    if (a.messageId !== b.messageId) {
      return (firstSeen.get(a.messageId)! - firstSeen.get(b.messageId)!) || (a.createdAt - b.createdAt);
    }
    if (a.blockIndex !== b.blockIndex) return a.blockIndex - b.blockIndex;
    return a.createdAt - b.createdAt;
  });
}
