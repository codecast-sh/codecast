// Live replies: the contract between the daemon's MessageDisplay hook receiver
// (packages/cli/src/replyStream.ts), the Convex row it pushes to
// (packages/convex/convex/replyStreams.ts) and the web's trailing block
// (packages/web/lib/replyStreamHandoff.ts).
//
// Claude Code writes a text block to its transcript only once the block is
// finished, so a long reply reaches the conversation view whole. Its
// MessageDisplay hook hands over each completed line while the reply is being
// written. The daemon joins those into the text so far and pushes it to one
// reused row per conversation, and the web draws that text after the last
// message until the real one arrives.
//
// THE HAND-OFF IS DERIVED, NEVER WRITTEN. The hook's message id cannot be
// joined to a transcript row, so nothing can replace the partial text with the
// final message in one write. Instead the web hides the row the moment the
// conversation holds an assistant message that starts with the same text and
// is stamped no earlier than the stream began (less a skew allowance). Either
// order of arrival then shows the text exactly once, and a wrong guess hides
// the stream, which is today's behaviour, rather than showing text twice.
//
// PURE isomorphic data: safe to import from the daemon, the Convex runtime and
// the browser.

/** The most text one row holds. A longer reply stops growing on screen and
 *  appears whole when its transcript block lands. */
export const REPLY_STREAM_MAX_CHARS = 64_000;

/** The web hides a row that has gone this long without a new push, by the
 *  time the browser received the last one. Long enough for a slow closing
 *  paragraph, which the hook holds until the message ends. */
export const REPLY_STREAM_STALE_MS = 60_000;

/** The query answers null for a row older than this, so a reload never draws
 *  a reply that stopped long ago. */
export const REPLY_STREAM_LOAD_MAX_AGE_MS = 120_000;

/** How far before the stream's start a message's timestamp may fall and still
 *  hand the stream off. */
export const REPLY_STREAM_HANDOFF_SKEW_MS = 60_000;

/** How many leading characters of the stream must open the message that hands
 *  it off. */
export const REPLY_STREAM_HANDOFF_PREFIX_CHARS = 200;

/** An assistant text message stamped no earlier than this before the stream's
 *  start hands it off whatever its text: sync can rewrite a message's opening
 *  (an image link, an error banner), and then the text no longer matches.
 *  Measured, a streamed message is stamped after its first line arrives; the
 *  text before a tool call is stamped seconds before the next stream starts. */
export const REPLY_STREAM_HANDOFF_STAMP_SLACK_MS = 1_000;

/** How far the browser's clock may run ahead of the server's before a row
 *  just pushed reads as old. A row first seen is as old as the server says,
 *  less this, so a reply that stopped long ago is not drawn afresh on reload. */
export const REPLY_STREAM_CLOCK_ALLOWANCE_MS = 5_000;

// A key block whose END line the stream has not reached. Redaction matches a
// key block whole, so until it closes its body would read as plain text.
const OPEN_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*KEY-----(?![\s\S]*-----END [A-Z0-9 ]*KEY-----)[\s\S]*$/;

/** `text` (already redacted) cut before a key block still being written. The
 *  stream stops there until the block closes and redacts whole, as it will in
 *  the message. The daemon applies it before a push leaves the machine and
 *  the server before it stores one. */
export function withoutOpenKeyBlock(text: string): string {
  return text.replace(OPEN_KEY_BLOCK, "");
}

/** What a push answers: written; nobody has the conversation open, so nothing
 *  was written; or the feature is off for the conversation's workspace. */
export type ReplyStreamPushResult = { state: "written" | "unwatched" | "off" };

export interface ReplyStreamRow {
  conversation_id: string;
  /** The hook's id for the message being written. Not a transcript id. */
  message_id: string;
  /** The reply so far. */
  text: string;
  /** Rises with each push of one message. */
  seq: number;
  /** The daemon's clock when the message's first line arrived. */
  started_at: number;
  updated_at: number;
}
