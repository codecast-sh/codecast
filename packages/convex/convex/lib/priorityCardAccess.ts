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

/** The row as `viewerId` may read it: anyone but the card's person gets it without the card. */
export function priorityCardForViewer<T extends { priority_card?: unknown; user_id: unknown }>(row: T, viewerId: unknown): T {
  if (!isPriorityCard(row) || String(row.user_id) === String(viewerId)) return row;
  const { priority_card: _, ...rest } = row;
  return rest as T;
}
