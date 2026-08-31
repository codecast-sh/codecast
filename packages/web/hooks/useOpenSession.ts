import { useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useLocation } from "react-router";
import { useInboxStore, isSessionHidden } from "../store/inboxStore";
import { isInboxSessionView, resolveSessionSelectKind } from "../lib/inboxRouting";
import { requestStagePlacement, sessionPanePath } from "../lib/stage";

// The one way to open a session from wherever the user is standing — the rail
// click, the Ctrl+Tab switcher, Ctrl+I/Ctrl+P jumps and the recents menu all
// go through here. On the inbox the session takes the stage in place; on every
// other surface "open" means leave for the inbox with the session current
// (there is no side-panel conversation any more — sidePanelSessionId is only
// the rail's highlight pointer, so writing it opens nothing).
export function useOpenSession(): (id: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  // Settings reads the REAL browser URL — usePathname can report the carried
  // tab path (same distinction DashboardLayout draws).
  const routerLocation = useLocation();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);
  const isOnSettingsPage = routerLocation.pathname.startsWith("/settings");
  const kind = resolveSessionSelectKind({ isOnSettingsPage, isOnInboxPage });

  const openInPlace = useCallback((id: string) => {
    const store = useInboxStore.getState();
    const sess = store.sessions[id];
    if (sess?.forked_from) {
      store.navigateToSession(id);
      if (store.showMySessions) store.setShowMySessions(false);
      return;
    }
    if (sess) {
      if (isSessionHidden(sess)) {
        store.setViewingDismissedId(id);
      } else {
        store.setCurrentSession(id);
      }
      if (store.showMySessions) store.setShowMySessions(false);
    } else {
      store.requestNavigate(id, { showMySessions: false });
    }
  }, []);

  // Leave the current page and open the session in the inbox. Routes through
  // navigateToSession so forks/dismissed/pending all resolve correctly.
  const leaveAndOpen = useCallback((id: string) => {
    const store = useInboxStore.getState();
    // A SPLIT stage makes "open this session" ambiguous — which pane? Offer
    // the pane picker with the conversation as the payload; the session opens
    // as a pane right where the user points. Un-split stages keep the direct
    // path: the conversation takes the stage.
    if (requestStagePlacement(sessionPanePath(id), store.sessions[id]?.title ?? undefined)) return;
    store.navigateToSession(id);
    router.push("/inbox");
  }, [router]);

  return kind === "leave" ? leaveAndOpen : openInPlace;
}
