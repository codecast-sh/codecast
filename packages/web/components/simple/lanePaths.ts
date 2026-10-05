// Where the simple lane lives, in a module that imports only shared data, so
// a page outside the app (the marketing site, signup) can link into the lane
// without loading the store or the lane's model. lanePref.ts and lane.ts
// re-export these names for everything inside the app.
import { BILLING_RETURN } from "@codecast/shared/contracts/assistant";

/** "simple" is the hosted assistant's lane; "full" or absent is the whole app. */
export type Lane = "simple" | "full";

/** Where each lane opens. */
export const LANE_HOME: Record<Lane, string> = { simple: "/simple", full: "/inbox" };

/** Where each surface of the lane lives. */
export const LANE_PATHS = {
  home: LANE_HOME.simple,
  approvals: "/simple/approvals",
  routines: "/simple/routines",
  connections: "/simple/connections",
  // Stripe returns people here (convex/billing.ts), so the server and the
  // route read the one path.
  plan: BILLING_RETURN.path,
  welcome: "/welcome",
} as const;

/** Which lane a person's client_state.ui says they live in. */
export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

export function conversationPath(id: string): string {
  return `/simple/c/${id}`;
}
