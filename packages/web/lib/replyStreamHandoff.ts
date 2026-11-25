// When the reply Claude Code is writing (a replyStreams row) may be drawn after
// the last message, and when the real message has taken its place. The
// contract and why the hand-off is derived rather than written are in
// @codecast/shared/contracts/replyStream.
//
// A wrong "handed off" hides the stream, which is how the conversation looked
// before streaming existed. A wrong "open" draws the reply twice. Every doubt
// here therefore resolves to handed off.
//
// Relative imports only: mobile's Metro reads shared web files and resolves
// `@/` to its own tree.
import {
  REPLY_STREAM_CLOCK_ALLOWANCE_MS,
  REPLY_STREAM_HANDOFF_PREFIX_CHARS,
  REPLY_STREAM_HANDOFF_SKEW_MS,
  REPLY_STREAM_HANDOFF_STAMP_SLACK_MS,
  REPLY_STREAM_STALE_MS,
  type ReplyStreamRow,
} from "@codecast/shared/contracts";

/** A row as the store holds it: the server's row, keyed by conversation id,
 *  with when this browser received its latest push. */
export type StoredReplyStream = ReplyStreamRow & { _id: string; received_at: number };

type MessageLike = { role: string; content?: string; timestamp: number };

// The transcript keeps a text block as written (packages/cli parser.ts joins a
// row's text blocks untrimmed), and the daemon builds the stream from the
// lines the hook hands over, so the two may differ in how lines and blank
// lines are joined. Compare with every run of whitespace as one space, ends
// trimmed.
const WS = /\s/;

// The stream's opening, cut once per row: the store hands back a new row
// object on every push, and a selector asks on every store change.
const prefixOf = new WeakMap<StoredReplyStream, string>();
function streamPrefix(row: StoredReplyStream): string {
  let prefix = prefixOf.get(row);
  if (prefix === undefined) {
    prefix = row.text.replace(/\s+/g, " ").trim().slice(0, REPLY_STREAM_HANDOFF_PREFIX_CHARS).trimEnd();
    prefixOf.set(row, prefix);
  }
  return prefix;
}

// Whether `content`, whitespace collapsed and trimmed, starts with `prefix`
// (already collapsed). Walks only as far as the prefix, so a long message
// costs no more than a short one.
function opensWith(content: string, prefix: string): boolean {
  let j = 0;
  let gap = false;
  for (let i = 0; i < content.length && j < prefix.length; i++) {
    const c = content[i];
    if (WS.test(c)) { gap = j > 0; continue; }
    if (gap) {
      if (prefix[j] !== " ") return false;
      j++;
      gap = false;
      if (j === prefix.length) return true;
    }
    if (prefix[j] !== c) return false;
    j++;
  }
  return j === prefix.length;
}

/** Whether the browser received a push for this row recently enough to draw it. */
export function replyStreamFresh(row: StoredReplyStream, now: number): boolean {
  return now - row.received_at < REPLY_STREAM_STALE_MS;
}

/** Whether `messages` (oldest first, as the store holds a conversation) holds
 *  the assistant message this stream was writing. Two ways:
 *  - stamped no earlier than the stream began, less the skew allowance, and
 *    opening with the stream's text;
 *  - an assistant TEXT row (non-blank `content`; a tool call or thinking row
 *    stores its text empty) stamped no earlier than the stream began, less
 *    the stamp slack, whatever its text: sync rewrites some openings (image
 *    links, error banners, truncation) and then the text no longer matches.
 *    The text written before a tool call is stamped seconds before the next
 *    stream starts, so it never hands that stream off this way.
 *  An empty stream counts as handed off: there is nothing to draw. */
export function replyStreamHandedOff(row: StoredReplyStream, messages: readonly MessageLike[] | undefined): boolean {
  const prefix = streamPrefix(row);
  if (!prefix) return true;
  if (!messages) return false;
  const since = row.started_at - REPLY_STREAM_HANDOFF_SKEW_MS;
  const stampedSince = row.started_at - REPLY_STREAM_HANDOFF_STAMP_SLACK_MS;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.timestamp < since) break;
    if (m.role !== "assistant") continue;
    const content = m.content ?? "";
    if (opensWith(content, prefix)) return true;
    if (m.timestamp >= stampedSince && content.trim()) return true;
  }
  return false;
}

/** When to count a pushed row as received, for staleness. The same push seen
 *  again (a revisit re-subscribes and gets the row the store already holds)
 *  keeps its first stamp. A row first seen is as old as the server says, so a
 *  reply that stopped long ago is stale on arrival; the clock allowance keeps
 *  a browser clock running a little ahead of the server's from making a fresh
 *  push look old. */
export function replyStreamReceivedAt(
  held: StoredReplyStream | undefined,
  row: Pick<ReplyStreamRow, "message_id" | "seq" | "updated_at">,
  now: number,
): number {
  if (held && held.message_id === row.message_id && held.seq === row.seq) return held.received_at;
  return Math.min(now, row.updated_at + REPLY_STREAM_CLOCK_ALLOWANCE_MS);
}

type StreamState = { replyStreams?: Record<string, StoredReplyStream>; messages: Record<string, readonly MessageLike[] | undefined> };

/** The reply being written that is not yet in the conversation's messages, as
 *  a short signature, `<message_id> <started_at>`, or "" when none is open: it
 *  changes when a reply opens, closes or moves to its next message, never on a
 *  push, so a view can subscribe to it. Freshness is time-driven, so the
 *  caller applies it with a coarse clock (replyStreamFresh). */
export function replyStreamSlotSig(state: StreamState, conversationId: string): string {
  const row = state.replyStreams?.[conversationId];
  if (!row || replyStreamHandedOff(row, state.messages[conversationId])) return "";
  return `${row.message_id} ${row.started_at}`;
}

/** The timeline row key of the reply being written. */
export function replyStreamRowKey(messageId: string): string {
  return `reply-stream:${messageId}`;
}
