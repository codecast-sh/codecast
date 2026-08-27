import { useInboxStore } from "../../store/inboxStore";
import { pathLabel } from "../../lib/pathLabel";
import { isDetachedTabWindow } from "../../lib/desktop";
import { settingsSectionForPath } from "../../lib/settingsSections";
import { isNonTabRoute } from "../../lib/tabRoutes";

// Re-exported so callers of the routing layer keep one import; the rule itself
// lives in lib/tabRoutes (pure, no store import) so the store can apply it too.
export { isNonTabRoute };



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
  // A detached tab window has no tab shell of its own — its store still
  // hydrates the SHARED tabs, so routing "within the active tab" here would
  // silently rewrite a tab owned by the main window. Navigate for real.
  if (isDetachedTabWindow()) return false;
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
export function tabNavigate(path: string, mode: "push" | "replace" = "push", fromTabId?: string) {
  const store = useInboxStore.getState();
  const tabId = fromTabId ?? store.activeTabId;
  if (tabId) store.updateTab(tabId, { path, title: pathLabel(path) });
  // A BACKGROUND pane navigating (a hidden prewarm tab canonicalizing its own
  // deep link, e.g. /files?path=…) moves only its tab's stored path. The
  // browser URL and history belong to the tab the user is looking at.
  if (fromTabId && fromTabId !== store.activeTabId) return;
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
