// A priority change card as a decision row (pl-1131): the row's
// `priority_card` is the proposal, option i is changes[i]. What the card's
// three answers send on the decision rail, what the row says once settled,
// and the one line a compact row asks.
import type { PriorityCard } from "@codecast/shared/contracts/priorityCard";
import type { DecisionAnswerInput, SessionDecisionItem } from "../store/inboxStore";
import type { PriorityCardAnswer, PriorityCardAnswered } from "../components/decisions/PriorityChangeCard";

type Row = Pick<SessionDecisionItem, "status" | "answer_json" | "answer_text" | "resolved_at"> & { priority_card?: PriorityCard };

/**
 * The card's answer as the store's answerDecision takes it. Accept sends the
 * ticked changes' option indexes (a multi answer); Accept none is a dismissal,
 * since a multi answer needs at least one index (convex normalizeVerdict); the
 * person's own words are a text answer.
 */
export function priorityCardAnswerInput(card: PriorityCard, answer: PriorityCardAnswer): DecisionAnswerInput {
  if (answer.kind === "none") return { dismiss: true };
  if (answer.kind === "text") return { text: answer.text };
  const on = new Set(answer.ids);
  return { json: card.changes.flatMap((c, i) => (on.has(c.id) ? [i] : [])) };
}

/** How the row settled, as the card draws it; null while it waits. The server's outcome wins once written. */
export function priorityCardAnswered(row: Row): PriorityCardAnswered | null {
  const card = row.priority_card;
  if (!card || row.status === "pending") return null;
  const text = row.answer_text || undefined;
  // Accept none is a dismissal; words with nothing accepted are a correction instead of an answer.
  const kindOf = (ids: string[]): PriorityCardAnswered["kind"] => (row.status === "dismissed" ? "none" : text && ids.length === 0 ? "text" : "accept");
  if (card.outcome) return { kind: kindOf(card.outcome.accepted), ids: card.outcome.accepted, text, at: card.outcome.at };
  const picked = row.status === "answered" && Array.isArray(row.answer_json) ? row.answer_json : [];
  const ids = picked.map((i: number) => card.changes[i]?.id).filter((id: string | undefined): id is string => !!id);
  return { kind: kindOf(ids), ids, text, at: row.resolved_at };
}

/** An answered card's headline: how many landed, none, or that the person answered in their own words. */
export function priorityCardHeadline(a: PriorityCardAnswered, total: number): string {
  if (a.kind === "text") return "You sent a correction";
  if (a.kind === "none") return "Accepted none";
  return `Accepted ${a.ids.length} of ${total}`;
}

/** A settled card's record, as a feed draws it: its headline and the person's words, if any. Null while it waits. */
export function priorityCardRecord(row: Row): { headline: string; text?: string } | null {
  const answered = priorityCardAnswered(row);
  if (!answered || !row.priority_card) return null;
  return { headline: priorityCardHeadline(answered, row.priority_card.changes.length), text: answered.text };
}

/** A compact row's one-line ask: how many changes the card proposes. */
export function priorityCardAsk(card: PriorityCard): string {
  const n = card.changes.length;
  return `${n} ${n === 1 ? "change" : "changes"} to your priorities`;
}

/** A settled row's answer in a word or two: the person's words, else how many changes were taken. */
export function priorityCardAnswerWord(row: Row): string | null {
  const answered = priorityCardAnswered(row);
  if (!answered || !row.priority_card) return null;
  if (answered.text) return answered.text;
  return answered.kind === "none" ? "Accepted none" : `Accepted ${answered.ids.length} of ${row.priority_card.changes.length}`;
}

/** The context's first line: the card's one short line of case under its headline. */
export function firstLine(md: string | undefined): string | undefined {
  return md?.split("\n").map((l) => l.trim()).find(Boolean);
}
