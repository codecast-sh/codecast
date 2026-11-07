// Side answers: `/btw <question>` in a conversation's composer, and the "Ask
// this session" panel that shows them: sending a question, and what a row
// shows (its answer, its failure in the panel's words, or pending). The
// composer command itself is parseSideQuestion (lib/builtinCommands).
//
// A side answer never reaches the agent or its transcript. The composer hands
// the question to askSideQuestion, which paints a pending row in the
// sideAnswers collection at once; the askSideQuestion dispatch side effect
// (convex/sideAnswers.ts) stores it and the cheap model's answer replaces it.

import { humanizeConvexError, type SideAnswerRow } from "@codecast/shared/contracts";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { toast } from "sonner";
import { settleEchoedSend } from "./decisionDiscussion";

export function newSideAnswerClientId(): string {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `btw:${id}`;
}

/** How long an answer may stay pending before the panel stops claiming it is
 *  coming: the server's own bound (convex sideAnswers SIDE_ANSWER_EXPIRE_MS),
 *  after which it settles the row failed itself. */
export const SIDE_ANSWER_STALL_MS = 10 * 60 * 1000;
const NO_ANSWER = "No answer came back. Ask again.";

export type SideAnswerView =
  | { kind: "pending" }
  | { kind: "answered"; answer: string; citations: Array<{ line: number; message_id: string }>; unread?: { after: number; before: number } }
  | { kind: "failed"; message: string };

/** The rows the panel lists: a failed question asked again later shows once, as its retry. */
export function visibleSideAnswers(rows: readonly SideAnswerRow[], now: number): SideAnswerRow[] {
  return rows.filter((r, i) => sideAnswerView(r, now).kind !== "failed" || !rows.slice(i + 1).some((later) => later.question === r.question));
}

/** What a row shows now: its answer, its failure in the panel's words, or pending
 *  (until it has been pending long enough that the answer is not coming). */
export function sideAnswerView(row: SideAnswerRow, now: number): SideAnswerView {
  if (row.status === "answered" && row.answer !== undefined) {
    return { kind: "answered", answer: row.answer, citations: row.citations ?? [], ...(row.unread ? { unread: row.unread } : {}) };
  }
  if (row.status === "failed") return { kind: "failed", message: sideAnswerErrorText(row.error_code, row.error_message) };
  if (now - row.created_at > SIDE_ANSWER_STALL_MS) return { kind: "failed", message: NO_ANSWER };
  return { kind: "pending" };
}

/** A failure in the panel's words: the server's coded refusals, anything else as a retry. */
export function sideAnswerErrorText(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "RATE_LIMITED":
      return message ?? "You have asked a lot this hour. Try again later.";
    case "INVALID":
      return message ?? "That question could not be asked.";
    case "TIMEOUT":
      return NO_ANSWER;
    case "MODEL_FAILED":
      return message ?? "The model did not answer.";
    case "NOT_FOUND":
      return "This session could not be found.";
    case "FORBIDDEN":
      // The server's words when it gave them: a team without a BAA refuses a session its members can read.
      return message ?? "You do not have access to read this session.";
    case "UNAUTHENTICATED":
      return "Sign in to ask about this session.";
    default:
      return "Could not answer just now. Try again in a moment.";
  }
}

/** A refused send in plain words: the server's own refusal, and a backend
 *  without side answers (an older deploy) as "not available". */
export function sideRefusalText(refusal: string): string {
  const text = humanizeConvexError(refusal, "That question could not be asked.");
  return text === "Unknown dispatch action" ? "Side answers are not available here yet." : text;
}

/** Ask a side question: it paints pending at once. A refusal takes the row back,
 *  says why, and resolves with the reason so the caller can return the text. */
export async function askSideQuestion(conversationId: string, question: string): Promise<string | null> {
  const q = question.trim();
  // A session still on its stub id has no server row to read yet.
  if (!q || !isConvexId(conversationId)) return null;
  const clientId = newSideAnswerClientId();
  const refusal = await settleEchoedSend(
    useInboxStore.getState().askSideQuestion(conversationId, q, clientId),
    () => useInboxStore.getState().dropSideAnswer(clientId),
  );
  if (!refusal) return null;
  const text = sideRefusalText(refusal);
  toast.error(text);
  return text;
}
