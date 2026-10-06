// The lane preference (`client_state.ui.lane`), in a module of its own with
// no router in it, so the full app (its shell, settings), the lane and the
// phone (packages/mobile app/(simple)) all read and write it the same way
// without loading the lane. The web gesture that also moves the view is
// useSetLane.ts.
import { useInboxStore } from "../../store/inboxStore";
import type { Lane } from "./lanePaths";

export { LANE_HOME, isHostedUi, laneOf, type Lane } from "./lanePaths";

/** The switch's words (settings and the command palette), the same on the
 *  web and the phone. On is hosted mode: the app for everyday work, with the
 *  Codecast assistant as the default and code, terminals and machines out of
 *  sight (lib/surfaces.ts decides which surfaces step back). */
export const LANE_SWITCH = {
  label: "Assistant mode",
  description: "Codecast for everyday work: new conversations go to the Codecast assistant, and code, terminals and machines step out of sight. Turn it off to bring them back",
  on: "Switch to assistant mode",
  off: "Switch to developer mode",
} as const;

/** Writes the preference through the store, so it shows at once and follows
 *  the person to every device. Moving the view is the caller's part. */
export function writeLane(lane: Lane): void {
  useInboxStore.getState().updateClientUI({ lane });
}
