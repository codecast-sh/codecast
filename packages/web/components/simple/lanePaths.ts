// Where the simple lane lives, in a module that imports only shared data, so
// a page outside the app (the marketing site, signup) can link into the lane
// without loading the store or the lane's model. lanePref.ts and lane.ts
// re-export these names for everything inside the app.
import { BILLING_RETURN } from "@codecast/shared/contracts/assistant";
import { LANE_CONVERSATION_ROUTE, LANE_ROOT, WELCOME_PATH } from "./laneBoot";

export { LANE_CONVERSATION_ROUTE };

/** "simple" is the hosted assistant's lane; "full" or absent is the whole app. */
export type Lane = "simple" | "full";

/** Where each lane opens. */
export const LANE_HOME: Record<Lane, string> = { simple: LANE_ROOT, full: "/inbox" };

/** Where each surface of the lane lives. */
export const LANE_PATHS = {
  home: LANE_HOME.simple,
  approvals: `${LANE_ROOT}/approvals`,
  routines: `${LANE_ROOT}/routines`,
  connections: `${LANE_ROOT}/connections`,
  // Stripe returns people here (convex/billing.ts), so the server and the
  // route read the one path.
  plan: BILLING_RETURN.path,
  welcome: WELCOME_PATH,
} as const;

/** Which lane a person's client_state.ui says they live in. */
export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

/** Hosted mode: the person lives in the hosted assistant's lane. Every
 *  reader of hosted mode asks this rather than comparing the lane string. */
export function isHostedUi(ui: { lane?: string } | null | undefined): boolean {
  return laneOf(ui) === "simple";
}

export function conversationPath(id: string): string {
  return LANE_CONVERSATION_ROUTE.replace(":id", id);
}
