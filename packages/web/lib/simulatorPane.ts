// The simulator an agent session holds, as a pane on the stage: the address,
// and opening it beside the conversation.
//
// The route names the agent session by its uuid (`/simulator?s=<uuid>`),
// because the daemon finds the device through the pool lock, which records the
// session that took it, never the conversation. Opening is always a click: an
// agent taking a simulator must not move what a person is looking at (the
// view-motion rule in store/viewNav.ts).

import { openBeside } from "./stage";
import { tabNavigate } from "../src/compat/tabRouting";

export const SIMULATOR_ROUTE = "/simulator";

export function simulatorPanePath(sessionUuid: string): string {
  return `${SIMULATOR_ROUTE}?s=${encodeURIComponent(sessionUuid)}`;
}

export function isSimulatorRoutePath(path: string): boolean {
  return path.split("?")[0].split("#")[0] === SIMULATOR_ROUTE;
}

/** The session uuid a simulator pane's path names, or null. */
export function simulatorPaneSession(path: string): string | null {
  if (!isSimulatorRoutePath(path)) return null;
  const query = path.split("?")[1]?.split("#")[0] ?? "";
  return new URLSearchParams(query).get("s") || null;
}

/** Beside the conversation when the stage has room, else in place. */
export function openSimulatorPane(sessionUuid: string): void {
  const path = simulatorPanePath(sessionUuid);
  if (!openBeside(path)) tabNavigate(path, "push");
}
