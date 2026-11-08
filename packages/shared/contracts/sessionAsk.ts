// What asking a session a question returns (convex/sessionAsk.ts): the CLI
// route and the web action answer with this one shape. It lives here so the
// web reads the type without importing the convex module that defines the
// functions.

export interface AskResult {
  conversation: { id: string; short_id: string; title: string; lines: number };
  question: string;
  answer: string;
  /** `cast read` numbers; negative ones count back from the end (-1 is the last). */
  cited_lines: number[];
  /** The message row behind each cited line, so a reader can open it without
   *  re-deriving `cast read` numbering. */
  citations: Array<{ line: number; message_id: string }>;
  terms: string[];
  scanned_lines: number;
  /** False when the session was too long to read whole within the budget. */
  scan_complete: boolean;
  /** When incomplete: every message between msg `after` and msg `before` was not read. */
  unread?: { after: number; before: number };
  shown_lines: number;
  matched_lines: number;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  took_ms: number;
  /** Only with debug.include_prompt. */
  prompt?: string;
}

/** When a side answer still pending is settled failed (convex sideAnswers.expire),
 *  and when the web stops showing it as coming. The read is bounded well inside
 *  this (convex sessionAsk.ts: a 120s scan, 20s and 90s model calls). */
export const SIDE_ANSWER_EXPIRE_MS = 10 * 60 * 1000;

/** A side answer (`/btw` in the composer, convex/sideAnswers.ts): one person's
 *  question about a conversation and the cheap model's answer, private to the
 *  asker and never sent to the agent. The web's optimistic row carries the same
 *  shape with a stub `_id` until the server row with its `client_id` lands. */
export interface SideAnswerRow {
  _id: string;
  conversation_id: string;
  client_id: string;
  question: string;
  status: "pending" | "answered" | "failed";
  answer?: string;
  citations?: Array<{ line: number; message_id: string }>;
  unread?: { after: number; before: number };
  error_code?: string;
  error_message?: string;
  created_at: number;
  answered_at?: number;
}

/**
 * An ask's failure with what to do next. A model failure is either transient
 * (overloaded, timed out: a retry in a moment works) or not (no credit, a
 * refused or invalid request: no retry helps), and both name the read that
 * works without the model. The server words its own errors with this, and the
 * CLI runs it again over whatever an older server or the connection said;
 * text that already names a command passes through unchanged.
 */
export function explainAskFailure(message: string, shortId: string): string {
  if (/cast (read|sessions|search|teams)/.test(message)) return message;
  const read = `cast read ${shortId} -n 20 reads its end, cast read ${shortId} --grep "<text>" finds a phrase`;
  if (/no session found|conversation not found/i.test(message)) {
    return `${message}. Check the id with \`cast sessions ${shortId}\`, or find the session with \`cast search <words>\``;
  }
  if (/do not have access|access denied|forbidden/i.test(message)) {
    return `${message}: it is private to its owner, or in a team you are not a member of. \`cast teams\` lists yours; the owner can share it`;
  }
  if (/asked a lot this hour/i.test(message)) return `${message}. Meanwhile ${read}`;
  const permanent = /credit balance|billing|answered 40[0-4]\b|invalid.*api.?key|authenticat|permission|not allowed|refus|prompt is too long|BAA|no model key/i;
  if (permanent.test(message)) return `${message}. Retrying will not help; ${read}`;
  const transient = /did not answer|gave no answer|timed out|call failed|answered (408|429|5\d\d)\b|overloaded|network|fetch failed/i;
  if (transient.test(message)) return `${message}. This usually clears: retry in about 30 s, or ${read}`;
  return message;
}
