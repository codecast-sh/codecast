// The seen record: one home, on the store, synced.
//
// A tour is seen when it was finished or dismissed. Both land in
// clientState.tips (completed / dismissed, set-union merged across devices)
// under the id `tour:<id>`, the same bag the inline tips use, so there is one
// record of what a person has already been shown. Reading also honours the
// records written before the tours existed (the inbox tour's `nux-tour` tip,
// the org guide's `org_nux_seen` pref), so nobody is shown twice what they
// already dismissed.
import type { ClientTips } from "../store/clientPrefsTypes";
import type { TourDef } from "./types";

export type TourSeenState = {
  clientState: { tips?: ClientTips | null; ui?: Record<string, unknown> | null };
  updateClientTips: (partial: Partial<ClientTips>) => void;
};

export function tourSeenId(tourId: string): string {
  return `tour:${tourId}`;
}

export type TourOutcome = "finished" | "skipped";

/** Finished or dismissed, by this record or a legacy one. */
export function isTourSeen(tour: TourDef, state: TourSeenState["clientState"]): boolean {
  const tips = state.tips;
  const ids = [tourSeenId(tour.id), ...(tour.legacy?.tips ?? [])];
  if (ids.some((id) => tips?.completed?.includes(id) || tips?.dismissed?.includes(id))) return true;
  const ui = state.ui;
  return (tour.legacy?.ui ?? []).some((key) => !!ui?.[key]);
}

/** Which record says so: for the panel's "Seen" tag. */
export function tourOutcome(tour: TourDef, state: TourSeenState["clientState"]): TourOutcome | null {
  const tips = state.tips;
  const ids = [tourSeenId(tour.id), ...(tour.legacy?.tips ?? [])];
  if (ids.some((id) => tips?.completed?.includes(id))) return "finished";
  if (isTourSeen(tour, state)) return "skipped";
  return null;
}

/** Write the record once. A finish after a skip upgrades the record (the
 *  panel then says Seen, not Skipped); a skip after a finish changes nothing. */
export function markTourSeen(store: TourSeenState, tourId: string, outcome: TourOutcome): void {
  const id = tourSeenId(tourId);
  const tips = store.clientState.tips;
  const completed = tips?.completed ?? [];
  const dismissed = tips?.dismissed ?? [];
  if (completed.includes(id)) return;
  if (outcome === "finished") {
    store.updateClientTips({ completed: [...completed, id] });
  } else if (!dismissed.includes(id)) {
    store.updateClientTips({ dismissed: [...dismissed, id] });
  }
}

/** Tours never write while a page runs on stub data (`?preview=1`, the org
 *  page's DEV preview): the record is a person's, not a fixture's. */
export function toursWriteSuppressed(search: string): boolean {
  return /(?:^|[?&])preview=1(?:&|$)/.test(search.replace(/^\?/, "?"));
}
