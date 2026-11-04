// The retired simple lane's addresses, which old links, pushes and returns
// still carry (lib/laneRedirect sends each to its main-app page), in a module
// that imports only shared data, so the router tests read them without the
// store.
import { LANE_CONVERSATION_ROUTE, LANE_ROOT, WELCOME_PATH } from "./laneBoot";

export { LANE_CONVERSATION_ROUTE };

export const LANE_PATHS = {
  home: LANE_ROOT,
  approvals: `${LANE_ROOT}/approvals`,
  routines: `${LANE_ROOT}/routines`,
  connections: `${LANE_ROOT}/connections`,
  plan: `${LANE_ROOT}/plan`,
  welcome: WELCOME_PATH,
} as const;

/** A conversation's address in the retired lane. */
export function conversationPath(id: string): string {
  return LANE_CONVERSATION_ROUTE.replace(":id", id);
}
