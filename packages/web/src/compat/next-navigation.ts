import { useCallback, useContext, useMemo } from "react";
import {
  UNSAFE_NavigationContext,
  resolvePath,
  useLocation,
  useSearchParams as useRRSearchParams,
  useParams as useRRParams,
} from "react-router";
import { useTabContext, useTabPane } from "@/lib/tabParams";
import { useInboxStore } from "@/store/inboxStore";
import { borrowsTabShell } from "@/lib/desktop";
import { interceptSettingsNav, shouldUseTabRouting, tabNavigate } from "./tabRouting";
import { divertNavigation } from "@/lib/openIntent";

/**
 * Returns the current pathname. When tabs are active, reads from the active
 * tab's path so the sidebar and other components outside TabParamsCtx
 * reflect the tab's current route.
 */
export function usePathname(): string {
  const tabCtx = useTabContext();
  const tabPath = useInboxStore((s) => {
    if (s.tabs.length > 0 && s.activeTabId) {
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      return tab?.path?.split("?")[0].split("#")[0] ?? null;
    }
    return null;
  });
  const routerPath = useLocation().pathname;

  if (tabCtx) return tabCtx.pathname;
  // A detached tab window or a browser pane's page hydrates the SHARED tabs
  // but renders no tab shell — the active tab there belongs to another window
  // and says nothing about what this document shows. Its truth is the real URL.
  if (tabPath && !borrowsTabShell()) return tabPath;
  return routerPath;
}

// react-router's useNavigate reads the location (BrowserRouter is not a data
// router), so every caller re-rendered on each URL change and got a new
// navigate. The navigator itself never changes; a path that is not absolute
// resolves against the current location, as useNavigate's does.
function useStableNavigate() {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback((to: string | number, options?: { replace?: boolean; state?: unknown }) => {
    if (typeof to === "number") { navigator.go(to); return; }
    const from = (navigator as { location?: { pathname: string } }).location?.pathname ?? window.location.pathname;
    const path = to.startsWith("/") ? to : resolvePath(to, from);
    if (options?.replace) navigator.replace(path, options.state);
    else navigator.push(path, options?.state);
  }, [navigator]);
}

export function useRouter() {
  const navigate = useStableNavigate();
  // The tab this component renders in, so a background (prewarm) pane's
  // navigations move its OWN tab instead of the one the user is looking at.
  const tabCtx = useTabPane();
  const tabId = tabCtx?.tabId;
  // A pane-hosted page (lib/tabParams `navigate`) routes within its pane.
  const paneNavigate = tabCtx?.navigate;
  return useMemo(
    () => ({
      // The second arg mirrors Next.js's `NavigateOptions` (e.g. `{ scroll }`).
      // We don't act on it, but accepting it keeps `router.push/replace(path,
      // { scroll: false })` call sites type-checking against this shim.
      // `state` is the history entry's own state (location.state), for a
      // screen that tells an in-screen open from an arrival by URL.
      push: (path: string, options?: { scroll?: boolean; state?: unknown }) => {
        // A Cmd-click's push opens the path in a background tab / detached
        // window instead (lib/openIntent) — the current view stays put.
        if (divertNavigation(path)) return;
        if (paneNavigate) { paneNavigate(path, "push"); return; }
        const settings = interceptSettingsNav(path);
        if (settings) {
          if (settings.carryUrl) navigate(settings.carryUrl, { replace: true });
          return;
        }
        if (shouldUseTabRouting(path)) {
          tabNavigate(path, "push", tabId, options?.state);
        } else {
          navigate(path, { state: options?.state });
        }
      },
      replace: (path: string, options?: { scroll?: boolean; state?: unknown }) => {
        // A replace canonicalizes the current URL; it never claims a Cmd-click
        // on its own, but stands down when a sibling push in the same click did.
        if (divertNavigation(path, { openable: false })) return;
        if (paneNavigate) { paneNavigate(path, "replace"); return; }
        const settings = interceptSettingsNav(path);
        if (settings) {
          if (settings.carryUrl) navigate(settings.carryUrl, { replace: true });
          return;
        }
        if (shouldUseTabRouting(path)) {
          tabNavigate(path, "replace", tabId, options?.state);
        } else {
          navigate(path, { replace: true, state: options?.state });
        }
      },
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => window.location.reload(),
      prefetch: (_path: string) => {},
    }),
    [navigate, tabId, paneNavigate],
  );
}

/** usePathname's answer, read when the returned function is called: for
 *  handlers that need the path without re-rendering on every navigation. */
export function useReadPathname(): () => string {
  const pane = useTabPane();
  return useCallback(() => {
    if (pane) return pane.getPath ? pane.getPath() : (pane as { pathname?: string }).pathname ?? window.location.pathname;
    const s = useInboxStore.getState();
    const tab = s.tabs.length > 0 && s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    const tabPath = tab?.path?.split("?")[0].split("#")[0];
    if (tabPath && !borrowsTabShell()) return tabPath;
    return window.location.pathname;
  }, [pane]);
}

export function useSearchParams(): URLSearchParams {
  const tabCtx = useTabContext();
  const [rrSearchParams] = useRRSearchParams();
  return tabCtx ? tabCtx.searchParams : rrSearchParams;
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const tabCtx = useTabContext();
  const rrParams = useRRParams();
  return (tabCtx ? tabCtx.params : rrParams) as T;
}

export function redirect(path: string): never {
  window.location.href = path;
  throw new Error("redirect");
}

export function notFound(): never {
  throw new Response("Not Found", { status: 404 });
}
