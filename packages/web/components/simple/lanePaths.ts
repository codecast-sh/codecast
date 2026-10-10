// Where the simple lane lives, in a module that imports only shared data, so
// a page outside the app (the marketing site, signup) can link into the lane
// without loading the store or the lane's model. lanePref.ts and lane.ts
// re-export these names for everything inside the app.
import { LANE_CONVERSATION_ROUTE, LANE_ROOT, WELCOME_PATH } from "./laneBoot";

export { LANE_CONVERSATION_ROUTE };

/** "simple" is the hosted assistant's lane; "full" or absent is the whole app. */
export type Lane = "simple" | "full";

/** Where hosted mode opens on the web: the main app's inbox, the same home
 *  as the developer default. */
export const HOSTED_HOME = "/inbox";

/** A conversation's page in the main app, hosted or not. */
export function hostedConversationPath(id: string): string {
  return `/conversation/${id}`;
}

/** The retired lane's addresses, which old links, pushes and returns still
 *  carry (lib/laneRedirect sends each to its main-app page), and /welcome. */
export const LANE_PATHS = {
  home: LANE_ROOT,
  approvals: `${LANE_ROOT}/approvals`,
  routines: `${LANE_ROOT}/routines`,
  connections: `${LANE_ROOT}/connections`,
  plan: `${LANE_ROOT}/plan`,
  welcome: WELCOME_PATH,
} as const;

/** The query /welcome reads a first ask from: a link on the marketing page
 *  carries the errand through sign-in, and Start offers it as the first
 *  thing to ask. */
export const WELCOME_ASK_PARAM = "ask";

/** /welcome, opening on `ask` as the first thing to ask. */
export function welcomeAskPath(ask: string): string {
  return `${WELCOME_PATH}?${WELCOME_ASK_PARAM}=${encodeURIComponent(ask)}`;
}

/** Which lane a person's client_state.ui says they live in. */
export function laneOf(ui: { lane?: string } | null | undefined): Lane {
  return ui?.lane === "simple" ? "simple" : "full";
}

/** Whether hosted mode and its doors (the Mode switch, /welcome, the
 *  assistant's Whisk card, the first run's assistant start) are open to this
 *  person: Codecast staff only for now. Everyone else stays in developer
 *  mode whatever their lane says. */
export function simpleModeAllowed(user: { staff?: boolean } | null | undefined): boolean {
  return user?.staff === true;
}

/** Hosted mode: the person lives in the hosted assistant's lane. Every
 *  reader of hosted mode asks this rather than comparing the lane string. */
export function isHostedUi(ui: { lane?: string } | null | undefined): boolean {
  return laneOf(ui) === "simple";
}

/** A conversation's address in the retired lane (lib/laneRedirect sends it
 *  to the conversation page). */
export function conversationPath(id: string): string {
  return LANE_CONVERSATION_ROUTE.replace(":id", id);
}

/** Whether an inbox row leads with its agent's glyph: on by default, off by
 *  default in hosted mode, where the person has the one assistant. */
export function showsAgentIcon(ui: { show_agent_icon?: boolean; lane?: string } | null | undefined): boolean {
  return ui?.show_agent_icon ?? !isHostedUi(ui);
}
