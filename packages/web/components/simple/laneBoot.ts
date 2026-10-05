// Where the lane's own pages live, and the pre-paint flag that says one is
// opening. This module imports nothing: plugins/laneBoot.ts inlines it into
// index.html's head, so the boot screen takes the lane's paper and mark before
// any module loads, and AppLoader reads the same rule once React is up.

/** The lane's home, under which every SimpleShell page lives. */
export const LANE_ROOT = "/simple";

/** Where someone new starts, signed in or not. */
export const WELCOME_PATH = "/welcome";

/** Every root the lane owns; the tab shell leaves these same paths alone. */
export const LANE_ROOTS = [LANE_ROOT, WELCOME_PATH] as const;

/** Where one lane conversation lives, as a route pattern and as a path. */
export const LANE_CONVERSATION_ROUTE = `${LANE_ROOT}/c/:id`;

/** Whether a pathname is `root` itself or a page under it. */
export function isUnderRoot(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(root + "/");
}

/** Whether a pathname is one of the lane's pages. */
export function isLanePath(pathname: string): boolean {
  return LANE_ROOTS.some((root) => isUnderRoot(pathname, root));
}

/** Whether this document is showing a lane page (false while prerendering). */
export function onLanePage(): boolean {
  return typeof location !== "undefined" && isLanePath(location.pathname);
}

/** The window title a lane page carries until its own (useLaneDocumentTitle,
 *  "Codecast Home" and the like) replaces it once the bundle runs. */
export const LANE_BOOT_TITLE = "Codecast";

/** Flags <html data-lane> on a lane page, for index.html's boot screen, and
 *  swaps index.html's marketing title for the product's plain name. */
export function markLanePage(): void {
  if (!onLanePage()) return;
  document.documentElement.setAttribute("data-lane", "");
  document.title = LANE_BOOT_TITLE;
}
