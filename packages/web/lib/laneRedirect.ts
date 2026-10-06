// Where an address of the retired simple lane (/simple and its pages) leads
// now that hosted mode lives in the main app: home is the inbox, a
// conversation is the conversation page, approvals are the questions page,
// routines are the triggers page, and connections and the plan are their
// settings sections. The query and fragment ride along, so an old Stripe
// return (?billing=) or Whisk return (?whisk=) still says how it went. Old
// links, bookmarks, pushes and the phone lane's addresses all arrive here.
import { HOSTED_HOME, LANE_CONVERSATION_ROUTE, LANE_PATHS, hostedConversationPath } from "../components/simple/lanePaths";
import { LANE_ROOT, isUnderRoot } from "../components/simple/laneBoot";
import { settingsPathFor } from "./settingsSections";

const PAGES: Record<string, string> = {
  [LANE_PATHS.home]: HOSTED_HOME,
  [LANE_PATHS.approvals]: "/questions",
  [LANE_PATHS.routines]: "/triggers",
  [LANE_PATHS.connections]: settingsPathFor("integrations"),
  [LANE_PATHS.plan]: settingsPathFor("plan"),
};

const CONVERSATION_PREFIX = LANE_CONVERSATION_ROUTE.replace(":id", "");

/** The main app's address for a lane address, or null for one outside the lane. */
export function laneRedirectTarget(pathname: string, search = "", hash = ""): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (!isUnderRoot(path, LANE_ROOT)) return null;
  const id = path.startsWith(CONVERSATION_PREFIX) ? path.slice(CONVERSATION_PREFIX.length).split("/")[0] : "";
  const to = id ? hostedConversationPath(id) : PAGES[path] ?? HOSTED_HOME;
  return `${to}${search}${hash}`;
}
