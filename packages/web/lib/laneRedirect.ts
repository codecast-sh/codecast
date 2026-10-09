// Where an address of the retired simple lane (/simple and its pages) leads
// now that hosted mode lives in the main app: home is the inbox, a
// conversation is the conversation page, approvals are the questions page,
// routines are the triggers page, and connections and the plan are their
// settings sections. The query and fragment ride along, so an old Stripe
// return (?billing=) or Whisk return (?whisk=) still says how it went. Old
// links, bookmarks, pushes and the phone lane's addresses all arrive here.
// The hosted page names (/approvals, /routines, /plan, /mail) redirect the
// same way, so an address guessed from the rail never lands on a profile 404.
import { HOSTED_HOME, LANE_CONVERSATION_ROUTE, LANE_PATHS, hostedConversationPath } from "../components/simple/lanePaths";
import { LANE_ROOT, isUnderRoot } from "../components/simple/laneBoot";
import { settingsPathFor } from "./settingsSections";
import { RENAMED_PAGES, RENAMED_PAGE_ROOTS, currentPagePath } from "./renamedPages";

const PAGES: Record<string, string> = {
  [LANE_PATHS.home]: HOSTED_HOME,
  [LANE_PATHS.approvals]: "/questions",
  [LANE_PATHS.routines]: "/triggers",
  [LANE_PATHS.connections]: settingsPathFor("integrations"),
  [LANE_PATHS.plan]: settingsPathFor("plan"),
};

const CONVERSATION_PREFIX = LANE_CONVERSATION_ROUTE.replace(":id", "");

/** The hosted words for the main app's pages, as addresses a person types
 *  or a support doc names (/approvals, /plan): each lane page without the
 *  lane root, plus /mail for the Whisk row. They redirect, so the page keeps
 *  one canonical URL. /routines is here too, but its route redirects only in
 *  hosted mode: in developer mode it is the workflows page. */
export const PAGE_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(PAGES)
      .filter(([lane]) => lane !== LANE_PATHS.home)
      .map(([lane, to]) => [lane.slice(LANE_ROOT.length), to]),
  ),
  "/integrations": settingsPathFor("integrations"),
  "/mail": settingsPathFor("integrations"),
  // The non-developer funnel's address: the landing page with its For
  // everyone section first (app/(marketing)/page.tsx assistantFirst).
  "/everyone": "/?for=assistant",
};

/** The root segments the aliases and renamed pages take, which no public profile may claim
 *  (convex/users.ts RESERVED_USERNAMES lists them too). */
export const PAGE_ALIAS_SEGMENTS = [...Object.keys(PAGE_ALIASES), ...Object.keys(RENAMED_PAGE_ROOTS), ...Object.keys(RENAMED_PAGES)].map((p) => p.slice(1));

function trimmed(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/** The main app's address for a lane address, or null for one outside the lane. */
export function laneRedirectTarget(pathname: string, search = "", hash = ""): string | null {
  const path = trimmed(pathname);
  if (!isUnderRoot(path, LANE_ROOT)) return null;
  const id = path.startsWith(CONVERSATION_PREFIX) ? path.slice(CONVERSATION_PREFIX.length).split("/")[0] : "";
  const to = id ? hostedConversationPath(id) : PAGES[path] ?? HOSTED_HOME;
  return `${to}${search}${hash}`;
}

/** The page a hosted page name or a renamed page's address stands for
 *  (/approvals is /questions, /goals/in-7 is /org/in-7), or null. */
export function pageAliasTarget(pathname: string, search = "", hash = ""): string | null {
  const path = trimmed(pathname);
  const renamed = currentPagePath(path);
  const to = PAGE_ALIASES[path] ?? (renamed !== path ? renamed : undefined);
  if (!to) return null;
  // An alias that carries its own query keeps the visitor's too (?utm_...).
  const query = to.includes("?") && search.startsWith("?") ? `&${search.slice(1)}` : search;
  return `${to}${query}${hash}`;
}
