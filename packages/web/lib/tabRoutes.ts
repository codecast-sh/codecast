// Which paths the dashboard tab shell can hold. Pure (no store import) so the
// store's own tab writers can apply the same rule the router compat layer uses;
// src/routes.manifest.test.ts parses the sets below for parity with App.tsx.

// Routes that live OUTSIDE the dashboard tab shell. The tab system (DashboardLayout
// / TabBar / TabContent) is only mounted for dashboard routes, but `tabs`/`activeTabId`
// persist across reloads and sign-out -- so a user who once used the dashboard still
// carries a tab into the marketing/auth pages. Tab routing must never intercept links
// on these routes, or it rewrites the URL via replaceState without navigating React
// Router (e.g. clicking "Sign in" lands you on /login in the address bar while the
// marketing page stays mounted until a manual reload).
const NON_TAB_EXACT = new Set([
  "/",
  // The published-page identity relay (redirects out to /a/<slug>; /pages
  // itself stays a tab page, so this is exact, not a prefix).
  "/pages/auth",
  "/about",
  "/features",
  "/privacy",
  "/security",
  "/support",
  "/terms",
  "/pricing",
  "/download",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/palette",
  // The people window renders the buddy list as a whole window (its own OS
  // window on the desktop, a popup in a browser). The tab shell must never
  // intercept it, or the window rewrites its own URL and paints a blank pane.
  "/people",
  // The call panel renders a huddle as a whole window (its own OS window on
  // the desktop, a detached tab window on older builds). Same reason as
  // /people: the tab shell intercepting it would rewrite the window's own URL
  // and paint a blank pane — with a live microphone behind it.
  "/call-panel",
  // The floating faces: a transparent always-on-top window that is nothing but
  // circles. The tab shell intercepting it would rewrite the window's own URL
  // and leave a see-through rectangle with a live microphone in it.
  "/call-faces",
]);
// "/documentation" is a prefix (not exact) so the guide pages under
// /documentation/<slug> stay outside the tab shell too.
const NON_TAB_PREFIXES = ["/settings", "/auth", "/join", "/share", "/blog", "/documentation", "/compare", "/a"];

// Every single-segment top-level route that lives INSIDE the dashboard (a tab
// page or a standalone shell page). Public profiles live at the root as a bare
// single segment (/:username), so the only way to tell `/ashot` (a handle, full-
// page, outside the shell) from `/inbox` (a tab) is to know the real routes: any
// bare single segment NOT in this set is a profile handle. KEEP IN SYNC with the
// single-segment <Route>s in src/App.tsx — the routes.manifest parity test asserts
// this set equals the manifest's in-shell single-segment routes, so drift fails loudly.
const IN_SHELL_ROOT_SEGMENTS = new Set([
  // Tab pages (TabContent patterns)
  "inbox", "feed", "crosstalk", "chat", "search", "notifications", "questions", "threads", "docs", "capabilities", "plans", "tasks", "files", "vault", "pages", "artifacts",
  "projects", "workflows", "routines", "triggers", "schedules", "sessions", "anchor", "team", "config", "calls",
  // Standalone shell pages (own <Route>, not in TabContent)
  "explore", "timeline", "windows", "orchestration", "roadmap", "cli",
]);

export function isNonTabRoute(path: string): boolean {
  const clean = path.split("?")[0].split("#")[0];
  if (NON_TAB_EXACT.has(clean)) return true;
  if (NON_TAB_PREFIXES.some((p) => clean === p || clean.startsWith(p + "/"))) return true;
  // A bare single segment that isn't a known in-shell route is a public-profile
  // handle (App.tsx serves PublicProfile at root-level ":username", outside the
  // shell). Without this, a signed-in user's in-app click to /<handle> would be
  // intercepted by the tab navigator into a blank TabContent pane.
  const single = clean.match(/^\/([^/]+)$/);
  if (single && !IN_SHELL_ROOT_SEGMENTS.has(single[1])) return true;
  return false;
}

/**
 * The only path a tab may hold. A tab whose path lies outside the shell (the
 * app root `/`, a marketing page, the palette/people windows) renders no pane
 * and pins the address bar to a dead URL: the shell paints a blank stage until
 * the user navigates by hand. That happened when the desktop, which always
 * boots at `/`, seeded its first tab from the live URL. Outside-shell paths
 * fall back to the inbox.
 */
export const DEFAULT_TAB_PATH = "/inbox";

export function shellTabPath(path: string | null | undefined): string {
  if (!path || typeof path !== "string") return DEFAULT_TAB_PATH;
  return isNonTabRoute(path) ? DEFAULT_TAB_PATH : path;
}

/** Heal a persisted tab list in place of trust: same array back when every
 *  tab already holds a shell path, so callers can detect a no-op cheaply. */
export function healTabPaths<T extends { path: string }>(tabs: T[]): T[] {
  let changed = false;
  const out = tabs.map((t) => {
    const path = shellTabPath(t.path);
    if (path === t.path) return t;
    changed = true;
    return { ...t, path };
  });
  return changed ? out : tabs;
}
