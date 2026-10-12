// Trial cards (convex lineTrial.ts): a trial project's line run stops at its
// gates without asking anyone, and the /trial page answers them. The answer
// paints the card at once and rides dispatch to the side effect of the same
// name (convex/dispatch.ts trialAnswer), which hands it to the paused run. A
// failed run's rerun rides trialRerun the same way.
import { action } from "./mutativeMiddleware";

export type TrialSliceActions = {
  /** Answer a trial card by its option key, with an optional note (Revise's words). */
  trialAnswer: (cardId: string, key: string, note?: string | null) => void;
  /** Run a failed trial run again (keyed by its problem), on a fresh branch from origin/main. */
  trialRerun: (taskId: string) => void;
};

type Cards = { trialCards: Record<string, any>; trialRuns: Record<string, any>; currentUser?: { _id: string } | null };

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
    // The row shows the new run at once; the server's row (its new run id) replaces it.
    trialRerun: action(function (this: Cards, taskId: string) {
      const row = this.trialRuns[taskId];
      if (!row || row.status !== "failed") return;
      row.status = "pending";
      row.fail_reason = null;
      row.fresh_branch = true;
      row.updated_at = Date.now();
    }) as TrialSliceActions["trialRerun"],
  };
}
