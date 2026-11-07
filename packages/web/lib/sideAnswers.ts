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
import { useInboxStore } from "../store/inboxStore";
import { toast } from "sonner";
import { settleEchoedSend } from "./decisionDiscussion";

export function newSideAnswerClientId(): string {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `btw:${id}`;
}

/** How long an answer may stay pending before the panel stops claiming it is
 *  still coming. The server's read is bounded well inside this (sessionAsk.ts). */
export const SIDE_ANSWER_STALL_MS = 6 * 60 * 1000;

export type SideAnswerView =
  | { kind: "pending" }
  | { kind: "answered"; answer: string; citations: Array<{ line: number; message_id: string }>; unread?: { after: number; before: number } }
  | { kind: "failed"; message: string };

/** What a row shows now: its answer, its failure in the panel's words, or pending
 *  (until it has been pending long enough that the answer is not coming). */
export function sideAnswerView(row: SideAnswerRow, now: number): SideAnswerView {
  if (row.status === "answered" && row.answer !== undefined) {
    return { kind: "answered", answer: row.answer, citations: row.citations ?? [], ...(row.unread ? { unread: row.unread } : {}) };
  }
  if (row.status === "failed") return { kind: "failed", message: sideAnswerErrorText(row.error_code, row.error_message) };
  if (now - row.created_at > SIDE_ANSWER_STALL_MS) return { kind: "failed", message: "No answer came back. Ask again." };
  return { kind: "pending" };
}

/** A failure in the panel's words: the server's coded refusals, anything else as a retry. */
export function sideAnswerErrorText(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "RATE_LIMITED":
      return message?.replace(/^Too many questions this hour; retry in/, "You have asked a lot this hour. Try again in") ?? "You have asked a lot this hour. Try again later.";
    case "INVALID":
      return message ?? "That question could not be asked.";
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

/** Ask a side question: it paints pending at once; a refusal takes the row back and says why. */
export async function askSideQuestion(conversationId: string, question: string): Promise<void> {
  const q = question.trim();
  if (!q || !conversationId) return;
  const clientId = newSideAnswerClientId();
  const refusal = await settleEchoedSend(
    useInboxStore.getState().askSideQuestion(conversationId, q, clientId),
    () => useInboxStore.getState().dropSideAnswer(clientId),
  );
  if (refusal) toast.error(sideRefusalText(refusal));
}
