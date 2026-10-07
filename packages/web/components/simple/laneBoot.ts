// Where the hosted family's own pages live, and the pre-paint flag that says
// one is opening. This module imports nothing: plugins/laneBoot.ts inlines it
// into index.html's head, so the boot screen takes the family's paper and
// mark before any module loads, and AppLoader reads the same rule once React
// is up.

/** The retired simple lane's root. Hosted mode lives in the main app now; an
 *  address under here redirects to its main-app page (lib/laneRedirect.ts). */
export const LANE_ROOT = "/simple";

/** Where someone new starts, signed in or not. */
export const WELCOME_PATH = "/welcome";

/** Every root outside the main app's shell; the tab shell leaves these same
 *  paths alone, so the router serves /welcome and runs the lane's redirects. */
export const LANE_ROOTS = [LANE_ROOT, WELCOME_PATH] as const;

/** The pages that boot in the family's look: /welcome alone. */
export const LANE_PAGES = [WELCOME_PATH] as const;

/** Where one lane conversation lives, as a route pattern and as a path. */
export const LANE_CONVERSATION_ROUTE = `${LANE_ROOT}/c/:id`;

/** Whether a pathname is `root` itself or a page under it. */
export function isUnderRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(root + "/");
}

/** Whether a pathname is one of the pages that boot in the family's look. */
export function isLanePath(pathname: string): boolean {
  return LANE_PAGES.some((root) => isUnderRoot(pathname, root));
}

/** Whether this document is showing a lane page (false while prerendering). */
export function onLanePage(): boolean {
  return typeof location !== "undefined" && isLanePath(location.pathname);
}

/** The window title a lane page carries until its own (useLaneDocumentTitle,
 *  "Codecast Welcome") replaces it once the bundle runs. */
export const LANE_BOOT_TITLE = "Codecast";

/** This device's last known mode, kept so a cold load paints the right mode
 *  before the client state arrives (a brand-new signup has no cache at all).
 *  The client state's `ui.lane` stays the one home of the preference: the hint
 *  is read only while that is unknown, and rewritten whenever it is known. */
export const LANE_HINT_KEY = "codecast-lane";
export type LaneHint = "simple" | "full";

export function readLaneHint(): LaneHint | null {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(LANE_HINT_KEY);
    return v === "simple" || v === "full" ? v : null;
  } catch {
    return null;
  }
}

export function writeLaneHint(lane: LaneHint): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LANE_HINT_KEY, lane);
  } catch {}
}

/** The attribute a hosted boot carries on <html>: the boot screen and
 *  AppLoader take the hosted loader from it. */
export const HOSTED_BOOT_ATTR = "data-hosted-boot";

/** Whether this document is a lane page, booted as hosted mode, or wears
 *  the hosted look: the loader then takes the hosted form. */
export function hostedBoot(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return onLanePage() || root.hasAttribute(HOSTED_BOOT_ATTR) || root.classList.contains("hosted-mode");
}

/** Flags <html data-lane> on a lane page, for index.html's boot screen, and
 *  swaps index.html's marketing title for the product's plain name. An app
 *  page on a device last seen in hosted mode is flagged as a hosted boot. */
export function markLanePage(): void {
  if (onLanePage()) {
    document.documentElement.setAttribute("data-lane", "");
    document.title = LANE_BOOT_TITLE;
    return;
  }
  // A hosted device's app page loads under the plain name, never the
  // developer marketing title, until the shell names what it shows.
  if (location.pathname !== "/" && readLaneHint() === "simple") {
    document.documentElement.setAttribute(HOSTED_BOOT_ATTR, "");
    document.title = LANE_BOOT_TITLE;
  }
}
