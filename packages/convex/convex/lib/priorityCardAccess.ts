// Who may answer a priority change card, and who may read it
// (shared/contracts/priorityCard.ts). The card is its person's alone: it
// quotes what they typed and holds the plan answering writes, and it sits in
// one of their sessions, which teammates may be able to read. A leaf, so every
// read path that returns decision rows can strip it.

import type { Id } from "../_generated/dataModel";

export const PRIORITY_CARD_REFUSED = "Only the person whose priorities these are answers this card";

/** Why `by` may not answer or dismiss a priority card, or null: only its person, in their own name (not an agent answering for them). */
export function priorityCardRefusal(row: { priority_card?: unknown; user_id: Id<"users"> }, by: { kind: string; user_id?: Id<"users">; via?: unknown }): string | null {
  if (!row.priority_card) return null;
  return by.kind === "user" && String(by.user_id) === String(row.user_id) && !by.via ? null : PRIORITY_CARD_REFUSED;
}

/** The row as `viewerId` may read it: anyone but the card's person gets it without the card. */
export function priorityCardForViewer<T extends { priority_card?: unknown; user_id: unknown }>(row: T, viewerId: unknown): T {
  if (!row.priority_card || String(row.user_id) === String(viewerId)) return row;
  const { priority_card: _, ...rest } = row;
  return rest as T;
}
