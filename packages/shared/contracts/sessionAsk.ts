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
