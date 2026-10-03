// When a running window asks its person to reload.
//
// Every deploy is applied silently: the service worker's onNeedReload reloads
// the window the next time it is hidden (createReloadWhenHidden). A window
// that never hides (a desktop main window on its own screen) would otherwise
// run the old bundle for days, so two cases also raise a card:
//
//  - release: the deploy bumped release-prompt.json's generation past this
//    bundle's (bumpReleasePrompt). Later dismisses that generation for good,
//    in every window.
//  - stale: an update has been waiting in this window for a day. Later snoozes
//    it for another day.
//
// Routine deploys therefore never interrupt anyone; the card is reserved for
// releases someone chose to announce and for windows left far behind.

export const STALE_PROMPT_AFTER_MS = 24 * 60 * 60 * 1000;
export const RECHECK_MS = 60 * 60 * 1000;

export type UpdatePromptKind = "release" | "stale";

export type UpdatePromptFacts = {
  bakedGeneration: number;
  servedGeneration: number;
  dismissedGeneration: number;
  updateWaitingSince: number;
  staleSnoozedUntil: number;
  now: number;
};

export function updatePromptKind(f: UpdatePromptFacts): UpdatePromptKind | null {
  if (f.servedGeneration > f.bakedGeneration && f.servedGeneration > f.dismissedGeneration) return "release";
  if (f.now - f.updateWaitingSince >= STALE_PROMPT_AFTER_MS && f.now >= f.staleSnoozedUntil) return "stale";
  return null;
}
