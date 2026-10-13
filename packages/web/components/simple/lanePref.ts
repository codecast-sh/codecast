// The lane preference (`client_state.ui.lane`, "simple" is hosted mode), in a
// module of its own with no router in it, so the web app (its shell,
// settings, the palette) and the phone (packages/mobile) read and write it
// the same way. On both the mode changes the app in place (lib/surfaces.ts);
// nothing moves the view.
import { useInboxStore } from "../../store/inboxStore";
import { isHostedUi, simpleModeAllowed, type Lane } from "./lanePaths";

export { isHostedUi, laneOf, type Lane } from "./lanePaths";

/** The switch's words (settings, the command palette and /welcome), the same
 *  on the web and the phone, with one name for the mode, "Everyday", as
 *  Settings' Mode choice says it. On is hosted mode: the app for everyday work, with the
 *  Codecast assistant as the default and code, terminals and machines out of
 *  sight (lib/surfaces.ts decides which surfaces step back). */
export const LANE_SWITCH = {
  label: "Everyday mode",
  description: "Codecast for everyday work: new conversations go to the Codecast assistant, and code, terminals and machines step out of sight. Turn it off to bring them back",
  on: "Switch to Everyday mode",
  off: "Switch to developer mode",
  /** The web's two-way choice under Appearance. */
  modeLabel: "Mode",
  everyday: "Everyday",
  developer: "Developer",
  everydayHint: "Everyday work with the Codecast assistant. Developer adds code, terminals and the machines that run them.",
  developerHint: "Code, terminals and machines. Everyday hides them and starts new conversations with the Codecast assistant.",
  /** /welcome's note to someone in developer mode: asking there switches. */
  welcomeSwitches: "Asking here switches Codecast to Everyday mode. You can switch back in Settings.",
} as const;

/** Writes the preference through the store, so it shows at once and follows
 *  the person to every device. Moving the view is the caller's part. */
export function writeLane(lane: Lane): void {
  useInboxStore.getState().setLane(lane);
}

/** Hosted mode is staff-only for now (simpleModeAllowed): someone else whose
 *  stored lane is "simple" is moved back to developer mode once their user
 *  and client state are known, so every reader of the lane agrees. */
export function retireLaneIfNotAllowed(): void {
  const s = useInboxStore.getState();
  if (s.currentUser && !simpleModeAllowed(s.currentUser) && isHostedUi(s.clientState.ui)) s.setLane("full");
}
