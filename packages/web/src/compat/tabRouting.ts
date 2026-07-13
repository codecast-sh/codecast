import { useInboxStore } from "@/store/inboxStore";
import { pathLabel } from "@/components/TabBar";
import { settingsSectionForPath } from "@/lib/settingsSections";

// Routes that live OUTSIDE the dashboard tab shell. The tab system (DashboardLayout
// / TabBar / TabContent) is only mounted for dashboard routes, but `tabs`/`activeTabId`
// persist across reloads and sign-out -- so a user who once used the dashboard still
// carries a tab into the marketing/auth pages. Tab routing must never intercept links
// on these routes, or it rewrites the URL via replaceState without navigating React
// Router (e.g. clicking "Sign in" lands you on /login in the address bar while the
// marketing page stays mounted until a manual reload).
const NON_TAB_EXACT = new Set([
  "/",
  "/about",
  "/features",
  "/documentation",
  "/privacy",
  "/security",
  "/support",
  "/terms",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/palette",
]);
const NON_TAB_PREFIXES = ["/settings", "/auth", "/join", "/share"];

// Every single-segment top-level route that lives INSIDE the dashboard (a tab
// page or a standalone shell page). Public profiles live at the root as a bare
// single segment (/:username), so the only way to tell `/ashot` (a handle, full-
// page, outside the shell) from `/inbox` (a tab) is to know the real routes: any
// bare single segment NOT in this set is a profile handle. KEEP IN SYNC with the
// single-segment <Route>s in src/App.tsx — the routes.manifest parity test asserts
// this set equals the manifest's in-shell single-segment routes, so drift fails loudly.
const IN_SHELL_ROOT_SEGMENTS = new Set([
  // Tab pages (TabContent patterns)
  "inbox", "feed", "crosstalk", "search", "notifications", "docs", "plans", "tasks",
  "projects", "workflows", "routines", "schedules", "sessions", "anchor", "team", "config",
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
 * In-app navigations to a settings SECTION open the settings modal in place
 * instead of routing to the legacy full-page /settings/* routes (those routes
 * remain for hard loads — SettingsLayout bounces them back into the modal).
 * Returns null when the path isn't a modal section, so flow pages like
 * /settings/team/create keep real navigation. When the settings URL carried a
 * query string (OAuth error returns, the team-setup handoff), `carryUrl` is
 * the current location with that query attached — the caller should
 * replace()-navigate to it so URL-param readers inside the modal panels see it.
 */
export function interceptSettingsNav(path: string): { carryUrl: string | null } | null {
  const hit = settingsSectionForPath(path);
  if (!hit) return null;
  useInboxStore.getState().openSettingsModal(hit.section);
  return { carryUrl: hit.search ? `${window.location.pathname}?${hit.search}` : null };
}

function isExternal(path: string): boolean {
  return path.startsWith("http") || path.startsWith("mailto:") || path.startsWith("#");
}

/**
 * Decide whether a navigation to `targetPath` should route within the active tab
 * (replaceState + updateTab) instead of via React Router. True only when tabs are
 * active AND both the current and target routes live inside the dashboard shell.
 * `currentPath` defaults to the live URL; pass it explicitly in tests.
 */
export function shouldUseTabRouting(
  targetPath: string,
  currentPath: string = typeof window !== "undefined" ? window.location.pathname : "/",
): boolean {
  if (isExternal(targetPath)) return false;
  if (isNonTabRoute(targetPath)) return false;
  if (isNonTabRoute(currentPath)) return false;
  const { tabs, activeTabId } = useInboxStore.getState();
  return tabs.length > 0 && !!activeTabId;
}

/**
 * Navigate within the active tab: update the tab's stored path AND the browser URL.
 *
 * `"push"` grows the browser history stack so the navigation is traversable with
 * back/forward; `"replace"` overwrites the current entry (URL canonicalization that
 * should not add history, e.g. dropping a `?highlight=` param). A push whose target
 * equals the current URL is downgraded to replace so we never stack duplicate
 * entries. The history `state` is tagged so the global popstate handler can tell a
 * tab navigation apart from an inbox session selection (`{ inboxId }`).
 */
export function tabNavigate(path: string, mode: "push" | "replace" = "push") {
  const store = useInboxStore.getState();
  const tabId = store.activeTabId;
  if (tabId) store.updateTab(tabId, { path, title: pathLabel(path) });
  const current = window.location.pathname + window.location.search;
  const state = { tabNav: true, tabId };
  if (mode === "push" && path !== current) {
    window.history.pushState(state, "", path);
    // Real (pushed) page navigations feed the recently-visited rail.
    // Conversations are recorded as sessions by recordSessionView instead.
    const clean = path.split("#")[0];
    if (!clean.startsWith("/conversation/")) {
      store.recordRecentVisit({ kind: "page", key: `page:${clean}`, path: clean, label: pathLabel(clean) });
    }
  } else {
    window.history.replaceState(state, "", path);
  }
}
