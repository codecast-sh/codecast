// Trial cards (convex lineTrial.ts): a trial project's line run stops at its
// gates without asking anyone, and the /trial page answers them. The answer
// paints the card at once and rides dispatch to the side effect of the same
// name (convex/dispatch.ts trialAnswer), which hands it to the paused run.
import { action } from "./mutativeMiddleware";

export type TrialSliceActions = {
  /** Answer a trial card by its option key, with an optional note (Revise's words). */
  trialAnswer: (cardId: string, key: string, note?: string | null) => void;
};

type Cards = { trialCards: Record<string, any>; currentUser?: { _id: string } | null };

export function createTrialSlice(): TrialSliceActions {
  return {
    trialAnswer: action(function (this: Cards, cardId: string, key: string, note?: string | null) {
      const card = this.trialCards[cardId];
      if (!card || card.status !== "waiting") return;
      const option = (card.options ?? []).find((o: any) => String(o.key).toUpperCase() === key.toUpperCase());
      if (!option) return;
      const now = Date.now();
      const text = note?.trim() || undefined;
      card.status = "answered";
      card.answer = { key: option.key, label: option.label, ...(text ? { note: text } : {}), at: now, by: String(this.currentUser?._id ?? ""), stand_in: false };
      card.updated_at = now;
    }) as TrialSliceActions["trialAnswer"],
  };
}
