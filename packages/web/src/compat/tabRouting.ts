import { useInboxStore } from "@/store/inboxStore";
import { pathLabel } from "@/components/TabBar";

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

export function isNonTabRoute(path: string): boolean {
  const clean = path.split("?")[0].split("#")[0];
  if (NON_TAB_EXACT.has(clean)) return true;
  return NON_TAB_PREFIXES.some((p) => clean === p || clean.startsWith(p + "/"));
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
  } else {
    window.history.replaceState(state, "", path);
  }
}
