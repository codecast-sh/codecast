import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore, selectSessionRailOpen } from "../store/inboxStore";
import { isNonTabRoute } from "../src/compat/tabRouting";
import type { ResolvedVisit } from "../lib/recentVisits";

// The one way to go to a recently visited thing, shared by the header menu,
// the Ctrl+Tab switcher and the command palette. Sessions open through the
// caller's own session handler (each surface has its own rules for that);
// label/project views apply the chip filter and reveal the session rail;
// pages navigate. `navigate` defaults to the router — the palette passes its
// own so the overlay closes with the move.
export function useOpenRecentVisit(
  onSelectSession: (id: string) => void,
  navigate?: (path: string) => void,
) {
  const router = useRouter();
  return useCallback(
    (item: ResolvedVisit) => {
      const go = navigate ?? ((path: string) => router.push(path));
      if (item.sessionId) {
        onSelectSession(item.sessionId);
        return;
      }
      if (item.bucketId || item.projectName) {
        const store = useInboxStore.getState();
        if (item.bucketId) store.setActiveBucketFilter(item.bucketId);
        else store.setActiveProjectFilter(item.projectName!, item.projectPath ?? null);
        if (!selectSessionRailOpen(store)) store.toggleSidePanel();
        // Views live in the session panel, which non-tab surfaces (Settings,
        // auth) don't render — head home to the inbox from those. The real
        // browser URL decides: usePathname can report the carried tab.
        if (isNonTabRoute(window.location.pathname)) go("/inbox");
        return;
      }
      if (item.path) go(item.path);
    },
    [onSelectSession, navigate, router],
  );
}
