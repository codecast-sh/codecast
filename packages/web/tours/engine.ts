// Start, step and end the running tour. The run itself is store.tour
// (ephemeral); ending writes the seen record (tours/seen.ts) unless the page
// runs on stub data.
import { useInboxStore } from "../store/inboxStore";
import { track } from "../lib/analytics";
import { tourById } from "./registry";
import { markTourSeen, toursWriteSuppressed, type TourOutcome } from "./seen";

/** Start a tour. `replay`: a person asked for it (the Tours panel, a link, a
 *  "How this page works"), so it runs whether or not it was seen. */
export function startTour(id: string, opts: { replay?: boolean } = {}): boolean {
  if (!tourById(id)) return false;
  const st = useInboxStore.getState();
  if (st.toursPanelOpen) st.setToursPanelOpen(false);
  st.setTour({ id, step: 0, replay: !!opts.replay });
  track("tour_started", { tour: id, replay: !!opts.replay });
  return true;
}

export function setTourStep(step: number): void {
  const st = useInboxStore.getState();
  if (st.tour && st.tour.step !== step) st.setTour({ ...st.tour, step });
}

/** End the running tour and record it, once, on the store. */
export function endTour(outcome: TourOutcome): void {
  const st = useInboxStore.getState();
  const run = st.tour;
  if (!run) return;
  const suppressed = typeof window !== "undefined" && toursWriteSuppressed(window.location.search);
  if (!suppressed) markTourSeen(st, run.id, outcome);
  st.setTour(null);
  track(outcome === "finished" ? "tour_finished" : "tour_skipped", { tour: run.id, step: run.step });
}
