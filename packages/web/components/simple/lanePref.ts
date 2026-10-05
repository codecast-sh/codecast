// The lane preference (`client_state.ui.lane`), in a module of its own with
// no router in it, so the full app (its shell, settings), the lane and the
// phone (packages/mobile app/(simple)) all read and write it the same way
// without loading the lane. The web gesture that also moves the view is
// useSetLane.ts.
import { useInboxStore } from "../../store/inboxStore";

/** "simple" is the hosted assistant's lane; "full" or absent is the whole app. */
export type Lane = "simple" | "full";

export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

/** Where each lane opens. */
export const LANE_HOME: Record<Lane, string> = { simple: "/simple", full: "/inbox" };

/** Writes the preference through the store, so it shows at once and follows
 *  the person to every device. Moving the view is the caller's part. */
export function writeLane(lane: Lane): void {
  useInboxStore.getState().updateClientUI({ lane });
}
