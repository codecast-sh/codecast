"use client";

import { useCallback } from "react";
import { useOpenSession } from "../hooks/useOpenSession";
import { usePathname, useRouter } from "next/navigation";
import { useInboxStore, selectCommentRailOpen, selectNavCollapsed } from "../store/inboxStore";
import { isInboxSessionView } from "../lib/inboxRouting";
import { overlayConversationId } from "../store/workspace";
import { focusComposer } from "../lib/composerControl";
import { isPeopleWindow } from "../lib/desktop";
import { useShortcutAction } from "./ShortcutProvider";
import { performUndo, performRedo } from "../store/undoStack";
import { useTriageActions } from "../components/triage/useTriageActions";
import { toggleTriageBarCompact } from "../components/triage/graduation";
import { checkMilestone } from "../tips/useTips";
import { switchToWorkbench, sortedWorkbenches } from "../lib/workbenchSwitch";

// The session a per-session chord (stash/kill/defer/pin/rename/label) acts on:
// the row the user sees highlighted. The fleet board's drill-in overlay wins
// outright when one is open: it is the topmost surface, a tile click only
// fills the workspace secondary slot (it never moves currentSessionId), and it
// can only exist on the inbox board — so it is read BEFORE isOnInboxPage,
// whose tab-aware pathname can lag the real URL right after a nav (the chord
// then consumed the key and no-op'd on a null side-panel selection). Otherwise
// on the inbox page it's the dismissed/stashed peek (viewingDismissedId), else
// the live current session; off the inbox it's the side panel's selection.
// This MUST mirror sessionListActiveId in DashboardLayout — without the
// viewingDismissedId term, peeking a stashed/dismissed session and hitting
// kill tore down whichever live session was sitting behind the peek (the row
// visible above it), not the hidden one you were looking at.
export function focusedActionSessionId(
  store: Pick<
    ReturnType<typeof useInboxStore.getState>,
    "currentSessionId" | "viewingDismissedId" | "sidePanelSessionId" | "workspace"
  >,
  isOnInboxPage: boolean,
): string | null | undefined {
  return overlayConversationId(store.workspace)
    ?? (isOnInboxPage
      ? (store.viewingDismissedId ?? store.currentSessionId)
      : store.sidePanelSessionId);
}

export function useGlobalShortcutActions() {
  const pathname = usePathname();
  const router = useRouter();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);
  const openSession = useOpenSession();

  useShortcutAction('session.next', useCallback(() => {
    const store = useInboxStore.getState();
    if (isOnInboxPage) {
      store.navigateDown();
    } else {
      const ordered = store.visualOrder();
      if (ordered.length === 0) return;
      const idx = ordered.findIndex(s => s._id === store.sidePanelSessionId);
      const newIdx = Math.min(idx + 1, ordered.length - 1);
      if (newIdx === idx) return;
      store.selectPanelSession(ordered[newIdx]._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.prev', useCallback(() => {
    const store = useInboxStore.getState();
    if (isOnInboxPage) {
      store.navigateUp();
    } else {
      const ordered = store.visualOrder();
      if (ordered.length === 0) return;
      const idx = ordered.findIndex(s => s._id === store.sidePanelSessionId);
      const newIdx = Math.max(idx - 1, 0);
      if (newIdx === idx) return;
      store.selectPanelSession(ordered[newIdx]._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.jumpIdle', useCallback(() => {
    // Ctrl+I: top of the your-move stack — Questions first, then Needs Input,
    // then Done (which reads as its extension); never Dormant, a machine wakes
    // those. The store hands back exactly the cards the panel files in those
    // sections, in render order (yourMoveOrder), so the target is always the
    // first such card the user can see — whatever view mode or old-session
    // toggle is up. Re-deriving membership here from a per-row classify is
    // what drifted: it missed the staleness net that files a quiet "working"
    // row under NEEDS INPUT and the in-flight send that lifts one out.
    const store = useInboxStore.getState();
    const first = store.yourMoveOrder()[0];
    if (first) openSession(first._id);
  }, [openSession]));

  useShortcutAction('session.jumpPinned', useCallback(() => {
    const store = useInboxStore.getState();
    const first = store.visualOrder().find(s => s.is_pinned);
    if (first) openSession(first._id);
  }, [openSession]));

  // The people wall, over whatever you were doing. Never in the people window
  // itself: the wall is already that window's whole view, and a modal wall over
  // it would be the same faces twice.
  useShortcutAction('people.wall', useCallback(() => {
    if (isPeopleWindow()) return;
    useInboxStore.getState().togglePeopleWall();
  }, []));

  // The verb bodies live in components/triage/useTriageActions — ONE
  // implementation shared with the triage bar's buttons, so a chord and its
  // button can never diverge (advance order, drill-in close, milestones).
  const triage = useTriageActions(isOnInboxPage);
  const focusedId = useCallback(() =>
    focusedActionSessionId(useInboxStore.getState(), isOnInboxPage), [isOnInboxPage]);

  useShortcutAction('session.pin', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.pin(currentId);
  }, [focusedId, triage]));

  useShortcutAction('session.stash', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.hide(currentId, "stash", "key");
  }, [focusedId, triage]));

  useShortcutAction('session.stashHide', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.hide(currentId, "stash", "key", { hidden: true });
  }, [focusedId, triage]));

  useShortcutAction('session.kill', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.hide(currentId, "kill", "key");
  }, [focusedId, triage]));

  useShortcutAction('session.deferAdvance', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.park(currentId, "defer", "key");
  }, [focusedId, triage]));

  useShortcutAction('session.dormantAdvance', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.park(currentId, "dormant", "key");
  }, [focusedId, triage]));

  useShortcutAction('session.rename', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    if (currentId) useInboxStore.setState({ renamingSessionId: currentId });
  }, [isOnInboxPage]));

  useShortcutAction('session.moveToBucket', useCallback(() => {
    const currentId = focusedId();
    if (currentId) triage.label(currentId);
  }, [focusedId, triage]));

  useShortcutAction('view.switch', useCallback(() => {
    // Straight into the palette's label/project view submenu (no targets —
    // the filter is global panel state, not a per-session action).
    useInboxStore.getState().openPalette({ mode: 'view' });
  }, []));

  useShortcutAction('ui.toggleShortcutsHelp', useCallback(() => {
    useInboxStore.getState().toggleShortcutsPanel();
  }, []));

  useShortcutAction('ui.openSettings', useCallback(() => {
    const s = useInboxStore.getState();
    if (s.settingsModalSection) s.closeSettingsModal();
    else s.openSettingsModal();
  }, []));

  useShortcutAction('ui.zenToggle', useCallback(() => {
    const store = useInboxStore.getState();
    const zen = store.clientState.ui?.zen_mode ?? false;
    if (!zen) checkMilestone('m-first-zen');
    store.updateClientUI({ zen_mode: !zen });
  }, []));

  useShortcutAction('inbox.toggleFlatView', useCallback(() => {
    useInboxStore.getState().cycleInboxViewMode();
  }, []));

  // No chord: the bar hides from its own menu, and the palette is the way
  // back — a hidden bar is not something to toggle by reflex.
  useShortcutAction('inbox.toggleTriageBar', useCallback(() => {
    toggleTriageBarCompact();
  }, []));

  useShortcutAction('nav.inbox', useCallback(() => {
    router.push("/inbox");
  }, [router]));

  useShortcutAction('compose.focus', useCallback(() => { focusComposer(); }, []));

  useShortcutAction('sidebar.toggleLeft', useCallback(() => {
    const store = useInboxStore.getState();
    store.setNavCollapsed(!selectNavCollapsed(store));
  }, []));

  useShortcutAction('sidebar.toggleRight', useCallback(() => {
    useInboxStore.getState().toggleSidePanel();
  }, []));


  useShortcutAction('sidebar.toggleComments', useCallback(() => {
    const store = useInboxStore.getState();
    store.setCommentRailOpen(!selectCommentRailOpen(store));
  }, []));

  useShortcutAction('terminal.toggle', useCallback(() => {
    const store = useInboxStore.getState();
    store.setDockOpen(store.workspace.dock.pane == null);
  }, []));

  useShortcutAction('anchor.toggle', useCallback(() => {
    useInboxStore.getState().toggleAnchorPanel();
  }, []));

  // ⌥1–⌥9: the first nine saved workbenches, in the rail's own order — the
  // hint printed on a row is the key that switches to it. No saved layouts,
  // no keys: the chords cost nothing until you save one.
  const switchWorkbench = useCallback((i: number) => {
    const store = useInboxStore.getState();
    const v = sortedWorkbenches(store)[i];
    if (v) switchToWorkbench(v.prefs as any, router, pathname, v._id);
  }, [router, pathname]);
  useShortcutAction('workbench.1', useCallback(() => switchWorkbench(0), [switchWorkbench]));
  useShortcutAction('workbench.2', useCallback(() => switchWorkbench(1), [switchWorkbench]));
  useShortcutAction('workbench.3', useCallback(() => switchWorkbench(2), [switchWorkbench]));
  useShortcutAction('workbench.4', useCallback(() => switchWorkbench(3), [switchWorkbench]));
  useShortcutAction('workbench.5', useCallback(() => switchWorkbench(4), [switchWorkbench]));
  useShortcutAction('workbench.6', useCallback(() => switchWorkbench(5), [switchWorkbench]));
  useShortcutAction('workbench.7', useCallback(() => switchWorkbench(6), [switchWorkbench]));
  useShortcutAction('workbench.8', useCallback(() => switchWorkbench(7), [switchWorkbench]));
  useShortcutAction('workbench.9', useCallback(() => switchWorkbench(8), [switchWorkbench]));

  useShortcutAction('ui.undo', useCallback(() => {
    return performUndo() || false;
  }, []));

  useShortcutAction('ui.redo', useCallback(() => {
    return performRedo() || false;
  }, []));

}
