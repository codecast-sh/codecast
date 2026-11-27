// The server's half of THE RULE for priority change cards (its text sits on
// isPriorityCard in shared/contracts/priorityCard.ts): a card belongs to its
// person alone and is acted on only through the card. Here: who may answer
// it, who may read it, the refusal every hand-off returns, and the predicate
// as a query filter. A leaf, so every chokepoint can import it.
// priorityCards.guard.test.ts lists every function that reads decisions by
// session or hands one off, and fails on one nobody has classified.

import type { Id } from "../_generated/dataModel";
import { isPriorityCard } from "@codecast/shared/contracts/priorityCard";

export { isPriorityCard };

/** isPriorityCard as a query filter that keeps every other row: `.filter(notPriorityCard).first()`. */
export const notPriorityCard = (q: any) => q.eq(q.field("priority_card"), undefined);

export const PRIORITY_CARD_REFUSED = "Only the person whose priorities these are answers this card";
export const PRIORITY_CARD_HANDOFF_REFUSED = "A priority card stays with its person: it is not passed, escalated or stacked";

/** Why `by` may not answer or dismiss a priority card, or null: only its person, in their own name (not an agent answering for them). */
export function priorityCardRefusal(row: { priority_card?: unknown; user_id: Id<"users"> }, by: { kind: string; user_id?: Id<"users">; via?: unknown }): string | null {
  if (!isPriorityCard(row)) return null;
  return by.kind === "user" && String(by.user_id) === String(row.user_id) && !by.via ? null : PRIORITY_CARD_REFUSED;
}

/**
 * Whether `viewerId` may receive the row at all: a priority card reaches its
 * person and nobody else, not even without its card (a bare pending row in
 * their session would read as that session's question to a teammate, and
 * its question and options are the person's). Every read path that returns
 * decision rows filters by it; lib/decisionAccess userMayRead answers it first.
 */
export function priorityCardVisibleTo(row: { priority_card?: unknown; user_id: unknown }, viewerId: unknown): boolean {
  return !isPriorityCard(row) || String(row.user_id) === String(viewerId);
}
