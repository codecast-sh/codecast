// Which paths the dashboard tab shell can hold. Pure (no store import) so the
// store's own tab writers can apply the same rule the router compat layer uses;
// src/routes.manifest.test.ts parses the sets below for parity with App.tsx.

import { countLeaves, findLeaf, leavesOf, sanitizeLayout, setLeafPath } from "../store/stageSplit";
// The single-segment routes that live inside the shell, shared with the
// desktop hand-off gate (which may import nothing, so the list lives there).
import { IN_SHELL_ROOT_SEGMENTS, isPublicProfilePath } from "./desktopHandoff";

export { IN_SHELL_ROOT_SEGMENTS };

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
  // The call window renders a huddle as a whole window (its own OS window on
  // the desktop, a detached tab window on older builds) — the stage, or the
  // circles its small sizes shrink to. Same reason as /people: the tab shell
  // intercepting it would rewrite the window's own URL and paint a blank pane,
  // with a live microphone behind it.
  "/call-panel",
  // The meeting-offer window: the record-this-meeting card as a small
  // chromeless corner window. Same rule again — the tab shell intercepting it
  // would rewrite the window's own URL and blank the card.
  "/meeting-offer",
  // The ring window: an incoming huddle as a small chromeless corner card.
  // Same rule again — the tab shell intercepting it would rewrite the
  // window's own URL and blank the card somebody is trying to answer.
  "/call-ring",
]);
// "/documentation" is a prefix (not exact) so the guide pages under
// /documentation/<slug> stay outside the tab shell too.
// "/r" is the standalone form of every repository page: its own window, guest
// readable, no shell. The tab shell intercepting one would rewrite that
// window's URL and paint a blank pane. "/repo" is a different route and stays
// tab-routable — the rule below matches "/r" and "/r/…" only.
const NON_TAB_PREFIXES = ["/settings", "/auth", "/join", "/share", "/blog", "/documentation", "/compare", "/a", "/r", "/slack/connect"];

export function isNonTabRoute(path: string): boolean {
  const clean = path.split("?")[0].split("#")[0];
  if (NON_TAB_EXACT.has(clean)) return true;
  if (NON_TAB_PREFIXES.some((p) => clean === p || clean.startsWith(p + "/"))) return true;
  // A bare single segment that isn't a known in-shell route is a public-profile
  // handle (App.tsx serves PublicProfile at root-level ":username", outside the
  // shell). Without this, a signed-in user's in-app click to /<handle> would be
  // intercepted by the tab navigator into a blank TabContent pane.
  return isPublicProfilePath(clean);
}

/**
 * The path the tab shell adopts into its active tab on entering router
 * location `key`, or null when there is nothing to adopt: the shell already
 * entered on this location (`entered`), or the location lies outside the
 * shell. The shell adopts the address bar once per router location — the
 * document's first load, and every real navigation that mounts it (a share
 * page resolving to a conversation, a sign-in returning to a task, history
 * landing on a shell route). A remount at the same location (the layout
 * around it changing, a tab switch) is not a navigation: adopting there
 * stamped whatever URL the previous tab had written into the tab being
 * switched to.
 */
export function shellEntryPath(entered: string | null, key: string, pathname: string, search: string): string | null {
  if (entered === key) return null;
  if (isNonTabRoute(pathname)) return null;
  return pathname + search;
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

/**
 * A real navigation from outside React: write the history entry, then fire the
 * popstate that browser back and forward fire, so React Router matches the new
 * URL and every popstate listener sees the move. Hook-free, so the store, the
 * stage and a document with no tab shell of its own can all call it. False
 * where there is no History API to write to.
 */
export function routerNavigate(
  path: string,
  mode: "push" | "replace" = "push",
  state: unknown = null,
): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.history?.pushState !== "function" ||
    typeof window.dispatchEvent !== "function"
  ) {
    return false;
  }
  if (mode === "push") window.history.pushState(state, "", path);
  else window.history.replaceState(state, "", path);
  window.dispatchEvent(
    typeof PopStateEvent === "function" ? new PopStateEvent("popstate", { state }) : new Event("popstate"),
  );
  return true;
}

export function shellTabPath(path: string | null | undefined): string {
  if (!path || typeof path !== "string") return DEFAULT_TAB_PATH;
  return isNonTabRoute(path) ? DEFAULT_TAB_PATH : path;
}

/** Heal a persisted tab list in place of trust: same array back when every
 *  tab already holds a shell path (and a well-formed split layout), so
 *  callers can detect a no-op cheaply. A tab's split layout comes from sync —
 *  other devices, other versions — so it is validated wholesale and dropped
 *  when malformed; the tab always keeps its plain path. A client that knows
 *  nothing of layouts may have rewritten `path` alone, so the focused leaf is
 *  re-synced to it here rather than trusted. */
export function healTabPaths<T extends { path: string; layout?: unknown; focusedLeafId?: unknown }>(tabs: T[]): T[] {
  let changed = false;
  const out = tabs.map((t) => {
    const path = shellTabPath(t.path);
    let next: T = t;
    if (path !== t.path) { next = { ...next, path }; changed = true; }
    if (t.layout !== undefined || t.focusedLeafId !== undefined) {
      const layout = sanitizeLayout(t.layout, (p) => !isNonTabRoute(p));
      if (!layout || countLeaves(layout) < 2) {
        next = { ...next, layout: undefined, focusedLeafId: undefined };
        changed = true;
      } else {
        const focusedId =
          typeof t.focusedLeafId === "string" && findLeaf(layout, t.focusedLeafId)
            ? t.focusedLeafId
            : leavesOf(layout)[0].id;
        const synced = setLeafPath(layout, focusedId, next.path);
        // Sanitizing always builds a fresh tree; only a SEMANTIC difference
        // counts as healing, so healthy tabs keep their identity (callers
        // detect the no-op by array identity).
        const layoutChanged =
          focusedId !== t.focusedLeafId || JSON.stringify(synced) !== JSON.stringify(t.layout);
        if (layoutChanged) {
          next = { ...next, layout: synced, focusedLeafId: focusedId };
          changed = true;
        }
      }
    }
    return next;
  });
  return changed ? out : tabs;
}
