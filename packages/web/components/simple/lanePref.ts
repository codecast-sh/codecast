// The lane preference (`client_state.ui.lane`), in a module of its own with
// no router in it, so the full app (its shell, settings), the lane and the
// phone (packages/mobile app/(simple)) all read and write it the same way
// without loading the lane. The web gesture that also moves the view is
// useSetLane.ts.
import { useInboxStore } from "../../store/inboxStore";
import type { Lane } from "./lanePaths";

export { LANE_HOME, laneOf, type Lane } from "./lanePaths";

/** The settings switch's words, the same on the web and the phone. */
export const LANE_SWITCH = {
  label: "Assistant view",
  description: "A calm home for asking your assistant to handle email, calendar and errands, with no code, terminals or machines in sight",
} as const;

/** Writes the preference through the store, so it shows at once and follows
 *  the person to every device. Moving the view is the caller's part. */
export function writeLane(lane: Lane): void {
  useInboxStore.getState().updateClientUI({ lane });
}
