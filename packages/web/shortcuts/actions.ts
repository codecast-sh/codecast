"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useInboxStore, classifySession, filterInboxScope, selectCommentRailOpen, selectNavCollapsed } from "../store/inboxStore";
import { liftQuestions } from "../lib/decisionQueue";
import { isInboxSessionView } from "../lib/inboxRouting";
import { overlayConversationId } from "../store/workspace";
import { focusComposer } from "../lib/composerControl";
import { useShortcutAction } from "./ShortcutProvider";
import { performUndo, performRedo } from "../store/undoStack";
import { animatedHideSession, undoableDeferSession, undoableDormantSession, undoablePinSession } from "../store/undoActions";
import { useTriggerKillNotice } from "../hooks/useTriggerKillNotice";
import { checkMilestone } from "../tips/useTips";
import { switchToWorkbench, sortedWorkbenches } from "../lib/workbenchSwitch";

// The session a per-session chord (stash/kill/defer/pin/rename/label) acts on:
// the row the user sees highlighted. On the inbox page that's the fleet
// board's drill-in overlay when one is open (the topmost surface — a tile
// click only fills the workspace secondary slot, it never moves
// currentSessionId), else the dismissed/stashed peek (viewingDismissedId),
// else the live current session; off the inbox it's the side panel's
// selection. This MUST mirror sessionListActiveId in DashboardLayout — without
// the viewingDismissedId term, peeking a stashed/dismissed session and hitting
// kill tore down whichever live session was sitting behind the peek (the row
// visible above it), not the hidden one you were looking at.
export function focusedActionSessionId(
  store: Pick<
    ReturnType<typeof useInboxStore.getState>,
    "currentSessionId" | "viewingDismissedId" | "sidePanelSessionId" | "workspace"
  >,
  isOnInboxPage: boolean,
): string | null | undefined {
  return isOnInboxPage
    ? (overlayConversationId(store.workspace) ?? store.viewingDismissedId ?? store.currentSessionId)
    : store.sidePanelSessionId;
}

export function useGlobalShortcutActions() {
  const pathname = usePathname();
  const router = useRouter();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);

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
    // Ctrl+I: top of the your-move stack — Questions/Needs Input first, then
    // Done, which sits directly below Needs Input and reads as its extension.
    // Never a Dormant row: a machine wakes those, so it's nobody's move to
    // jump to (the bare waiting predicate matches parked rows too).
    // Questions need their own rule, not an approximation via `waiting`: an
    // advisory `cast decide` (and a working parent lifted by an asking
    // subagent) renders at the top of the QUESTIONS section while the agent is
    // still WORKING, so classifySession().waiting is false and the visibly
    // first card would be skipped. Mirror the section's own membership.
    const store = useInboxStore.getState();
    const ordered = store.visualOrder();
    const { isQuestion } = liftQuestions(
      [],
      store.sessionDecisions,
      filterInboxScope(store.sessions, "mine", store.currentUser?._id?.toString?.() ?? null),
      store.questionResolutions,
    );
    const first = ordered.find(s => {
      if (isQuestion(s)) return true;
      const c = classifySession(s);
      return c.waiting && c.rest !== "dormant";
    });
    if (!first) return;
    if (isOnInboxPage) store.setCurrentSession(first._id);
    else store.selectPanelSession(first._id);
  }, [isOnInboxPage]));

  useShortcutAction('session.jumpPinned', useCallback(() => {
    const store = useInboxStore.getState();
    const ordered = store.visualOrder();
    const first = ordered.find(s => s.is_pinned);
    if (!first) return;
    if (isOnInboxPage) store.setCurrentSession(first._id);
    else store.selectPanelSession(first._id);
  }, [isOnInboxPage]));

  useShortcutAction('session.pin', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    if (currentId) {
      const session = store.sessions[currentId];
      if (session && !session.is_pinned) checkMilestone('m-first-pin');
      undoablePinSession(currentId);
    }
  }, [isOnInboxPage]));

  // A triage verb that removes the row from its band finishes by closing the
  // fleet drill-in when it was the target: the board behind it is what shows
  // the result (the tile moves bands), and leaving the just-parked
  // conversation modally on top would hide exactly that.
  const closeOverlayIfCurrent = useCallback((id: string) => {
    const store = useInboxStore.getState();
    if (overlayConversationId(store.workspace) === id) {
      store.wsHide("secondary", { remember: false });
    }
  }, []);

  // Shared body of the stash/kill chords; the only difference is the mode.
  // The kill itself happens SERVER-side on the hide data transition
  // (dispatch.applyPatches), so neither handler asks for it. The kill chord
  // routes through the notice hook so it names any schedules the kill cancels,
  // same as the sidebar button and the palette.
  const { killWithNotice } = useTriggerKillNotice();
  const hideCurrent = useCallback((mode: "stash" | "kill") => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    if (!currentId) return;
    if (mode === "stash") checkMilestone('m-first-stash');
    if (!isOnInboxPage) {
      const ordered = store.visualOrder();
      const idx = ordered.findIndex(s => s._id === currentId);
      const next = ordered.slice(idx + 1).find(s => s._id !== currentId)
        ?? ordered.find(s => s._id !== currentId);
      if (next) store.selectPanelSession(next._id);
    }
    if (mode === "kill") killWithNotice(currentId);
    else animatedHideSession(currentId, mode);
    closeOverlayIfCurrent(currentId);
  }, [isOnInboxPage, killWithNotice, closeOverlayIfCurrent]);

  useShortcutAction('session.stash', useCallback(() => hideCurrent("stash"), [hideCurrent]));

  useShortcutAction('session.kill', useCallback(() => hideCurrent("kill"), [hideCurrent]));

  // Defer and dormant share one shape: stamp the focused row, then advance the
  // selection to the next row in visual order.
  const stampAndAdvance = useCallback((stamp: (id: string) => void) => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    if (!currentId) return;
    const ordered = store.visualOrder();
    const idx = ordered.findIndex(s => s._id === currentId);
    const next = ordered[idx + 1] ?? ordered.find(s => s._id !== currentId);
    stamp(currentId);
    closeOverlayIfCurrent(currentId);
    if (next) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
  }, [isOnInboxPage, closeOverlayIfCurrent]);

  useShortcutAction('session.deferAdvance', useCallback(() => stampAndAdvance(undoableDeferSession), [stampAndAdvance]));
  useShortcutAction('session.dormantAdvance', useCallback(() => stampAndAdvance(undoableDormantSession), [stampAndAdvance]));

  useShortcutAction('session.rename', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    if (currentId) useInboxStore.setState({ renamingSessionId: currentId });
  }, [isOnInboxPage]));

  useShortcutAction('session.moveToBucket', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = focusedActionSessionId(store, isOnInboxPage);
    const session = currentId ? store.sessions[currentId] : null;
    if (session) store.openPalette({ targets: [session], targetType: 'session', mode: 'bucket' });
  }, [isOnInboxPage]));

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
