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
