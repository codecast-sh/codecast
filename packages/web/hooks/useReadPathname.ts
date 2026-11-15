import { useCallback } from "react";
import { borrowsTabShell } from "../lib/desktop";
import { useTabPane } from "../lib/tabParams";
import { useInboxStore } from "../store/inboxStore";

/** usePathname's answer, read when the returned function is called: for
 *  handlers that need the path without re-rendering on every navigation.
 *  Relative imports only: mobile's bundle reaches its caller. */
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
