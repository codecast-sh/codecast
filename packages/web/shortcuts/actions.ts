"use client";

import { toggleAppAddressBar } from "../lib/appAddress";
import { startTour } from '../tours/engine';
import { toast } from "sonner";
import { isForeignSession } from "../lib/liveEntities";
import { resolvePaletteTarget } from "../lib/paletteTarget";

import { useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useOpenSession } from "../hooks/useOpenSession";
import { navBack } from "../hooks/useNavTrail";
import { usePathname, useRouter } from "next/navigation";
import { useInboxStore, selectCommentRailOpen, selectNavCollapsed, type InboxWalk } from "../store/inboxStore";
import { useInboxSelection } from "../lib/inboxSelection";
import { isInboxRoute, isInboxSessionView } from "../lib/inboxRouting";
import { overlayConversationId } from "../store/workspace";
import { focusComposer } from "../lib/composerControl";
import { isPeopleWindow } from "../lib/desktop";
import { oldestBlocked } from "../lib/decisionQueue";
import { subscribeShortcutUsed, useShortcutAction } from "./ShortcutProvider";
import { claimKeys } from "./keyOwnership";
import { useUndoWalk } from "../hooks/useUndoWalk";
import { useTriageActions } from "../components/triage/useTriageActions";
import { toggleTriageBarCompact } from "../components/triage/graduation";
import { checkMilestone } from "../tips/useTips";
import { menuVerb, noteKeyboardNavigation, noteRowVerbActed, rowVerbIds, watchHoverTarget } from "../lib/hoverTarget";
import { animatedCloseSessions, animatedHideSessions, fileSessionsAsRest, toggleSessionsLikeFirst } from "../store/undoActions";
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
// visible above it), not the hidden one you were looking at. heldViewId is the
// same rule for a link target the inbox pane holds on screen while it is not
// in `sessions` (a teammate's share opened from the browser handoff): the
// current session sits hidden behind it, and Ctrl+Shift+Backspace there
// killed that session 24 seconds after it was created (jx7970z, 2026-10-06).
export function focusedActionSessionId(
  store: Pick<
    ReturnType<typeof useInboxStore.getState>,
    "currentSessionId" | "viewingDismissedId" | "heldViewId" | "sidePanelSessionId" | "workspace"
  >,
  isOnInboxPage: boolean,
): string | null | undefined {
  return overlayConversationId(store.workspace)
    ?? (isOnInboxPage
      ? (store.heldViewId ?? store.viewingDismissedId ?? store.currentSessionId)
      : store.sidePanelSessionId);
}

// The sessions a row verb (close, stash, pin, defer…) acts on (rowVerbIds in
// lib/hoverTarget): an open context menu's sessions, else the row the pointer
// moved onto, else nothing while another row shows its hover toolbar, else
// the focused card. `advance` is false unless the one target is the focused card:
// acting on another row must not move the view.
export function rowVerbTarget(
  store: Parameters<typeof focusedActionSessionId>[0],
  isOnInboxPage: boolean,
): { ids: string[]; advance: boolean } | null {
  const focused = focusedActionSessionId(store, isOnInboxPage);
  const ids = rowVerbIds(focused);
  return ids.length ? { ids, advance: ids.length === 1 && ids[0] === focused } : null;
}

// Every input to focusedActionSessionId, whichever page it is read on.
function focusSignature(store: Parameters<typeof focusedActionSessionId>[0]): string {
  return [overlayConversationId(store.workspace), store.heldViewId, store.viewingDismissedId, store.currentSessionId, store.sidePanelSessionId].join("|");
}

export function useGlobalShortcutActions() {
  const pathname = usePathname();
  const router = useRouter();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);
  const openSession = useOpenSession();

  useMountEffect(() => watchHoverTarget());
  // A key that moved the focused card hands row chords to it until the pointer
  // moves (lib/hoverTarget). The focus is read before each key (a claim that
  // takes nothing, run ahead of the dispatcher) and again after its handler:
  // store reads only, no DOM, so typing stays cheap.
  useMountEffect(() => {
    let before = "";
    const releaseClaim = claimKeys(() => { before = focusSignature(useInboxStore.getState()); return false; });
    const unsubscribe = subscribeShortcutUsed(() => {
      if (focusSignature(useInboxStore.getState()) !== before) noteKeyboardNavigation();
    });
    return () => { releaseClaim(); unsubscribe(); };
  });

  useShortcutAction('palette.toggle', useCallback(() => {
    const state = useInboxStore.getState();
    if (state.palette.open) {
      state.closePalette();
      return;
    }
    // A ticked multi-selection (lib/inboxSelection) is the target when there
    // is one, ahead of the conversation open beside it: the bar says "N
    // selected", so every verb acts on all of it.
    const picked = useInboxSelection.getState().ids
      .map((id) => state.sessions[id] ?? state.conversations[id])
      .filter(Boolean);
    if (picked.length > 1) {
      state.openPalette({ targets: picked, targetType: 'session' });
      return;
    }
    const target = resolvePaletteTarget(state, pathname);
    if (target) { state.openPalette(target); return; }
    if (isInboxRoute(pathname)) {
      const focusedId = focusedActionSessionId(state, true);
      const session = focusedId ? state.sessions[focusedId] ?? state.conversations[focusedId] : null;
      if (session) {
        state.openPalette({ targets: [session], targetType: 'session' });
        return;
      }
    }
    if (pathname === '/tasks' || pathname === '/docs') return false;
    state.togglePalette();
  }, [pathname]));

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

  // Jump to the first visible card of one inbox section, in render order
  // (walkOrder): the store hands back exactly the cards the panel files there,
  // whatever view mode or old-session toggle is up. Ctrl+I is NEEDS YOU, then
  // DONE when nothing needs you; it never lands on a decision, which has its
  // own key.
  const jumpTo = useCallback((...walks: InboxWalk[]) => {
    const store = useInboxStore.getState();
    for (const walk of walks) {
      const first = store.walkOrder(walk)[0];
      if (first) return openSession(first._id);
    }
  }, [openSession]);
  useShortcutAction('session.jumpIdle', useCallback(() => jumpTo("needsYou", "done"), [jumpTo]));
  useShortcutAction('session.jumpDecision', useCallback(() => jumpTo("decisions"), [jumpTo]));
  useShortcutAction('session.jumpDone', useCallback(() => jumpTo("done"), [jumpTo]));

  // The session whose prompt has waited longest, among the cards the panel
  // shows as waiting on you.
  useShortcutAction('permission.jumpOldest', useCallback(() => {
    const store = useInboxStore.getState();
    const oldest = oldestBlocked(store.walkOrder("yourMove"));
    if (oldest) openSession(oldest._id);
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
  const target = useCallback(() =>
    rowVerbTarget(useInboxStore.getState(), isOnInboxPage), [isOnInboxPage]);

  // One press, one gesture. A multi-session target comes only from a bulk
  // context menu, and goes through that menu's own handler where it has one
  // (its notices included), else the same bulk helper as its items (one undo
  // entry for the whole selection); a verb with no bulk form (defer,
  // rename, label) does nothing on a selection. One row goes through the
  // triage verb shared with the bar. `removed`: the verb takes the row out of
  // the list (noteRowVerbActed).
  const runVerb = useCallback((
    removed: boolean,
    single: (id: string, advance: boolean) => void,
    bulk?: (ids: string[]) => void,
  ) => {
    const t = target();
    if (!t) return;
    if (t.ids.length === 1) single(t.ids[0]!, t.advance);
    else if (bulk) bulk(t.ids);
    else return;
    noteRowVerbActed(removed);
  }, [target]);

  useShortcutAction('session.pin', useCallback(() => {
    runVerb(false, (id) => triage.pin(id), (ids) => toggleSessionsLikeFirst(ids, "pin"));
  }, [runVerb, triage]));

  // Leave the row lit. Deliberately NOT a triage verb: it moves
  // nothing and advances nothing — the session stays where it is, wearing the
  // dot, until the next visit acknowledges it.
  useShortcutAction('session.markUnread', useCallback(() => {
    const mark = (ids: string[]) => {
      for (const id of ids) useInboxStore.getState().markSessionUnread(id);
      toast.success("Marked unread");
    };
    runVerb(false, (id) => mark([id]), mark);
  }, [runVerb]));

  useShortcutAction('session.stash', useCallback(() => {
    runVerb(true, (id, advance) => triage.hide(id, "stash", "key", undefined, advance),
      (ids) => { const own = menuVerb("stash"); if (own) own(ids); else void animatedHideSessions(ids, "stash"); });
  }, [runVerb, triage]));

  useShortcutAction('session.stashHide', useCallback(() => {
    runVerb(true, (id, advance) => triage.hide(id, "stash", "key", { hidden: true }, advance),
      (ids) => { void animatedHideSessions(ids, "stash", { hidden: true }); });
  }, [runVerb, triage]));

  useShortcutAction('session.close', useCallback(() => {
    runVerb(true, (id, advance) => triage.hide(id, "close", "key", undefined, advance),
      (ids) => { const own = menuVerb("close"); if (own) own(ids); else void animatedCloseSessions(ids); });
  }, [runVerb, triage]));

  useShortcutAction('session.deferAdvance', useCallback(() => {
    runVerb(true, (id, advance) => triage.park(id, "defer", "key", advance));
  }, [runVerb, triage]));

  useShortcutAction('session.dormantAdvance', useCallback(() => {
    runVerb(true, (id, advance) => triage.park(id, "dormant", "key", advance),
      (ids) => { void fileSessionsAsRest(ids, "dormant"); });
  }, [runVerb, triage]));

  // The page's own conversation is the card snooze falls back to, ahead of
  // the inbox's focused card; the row rule (an open menu, a hovered row)
  // still comes first.
  useShortcutAction('session.snooze', useCallback(() => {
    const state = useInboxStore.getState();
    const page = resolvePaletteTarget(state, pathname);
    const pageSession = page?.targetType === 'session' ? page.targets[0] : null;
    const ids = rowVerbIds(pageSession?._id ?? focusedActionSessionId(state, isOnInboxPage));
    const sessions = ids
      .map((id) => (id === pageSession?._id ? pageSession : state.sessions[id] ?? state.conversations[id]))
      .filter((session) => session && !session.inbox_killed_at && state.currentUser && !isForeignSession(session, session, state.currentUser._id.toString()));
    if (!sessions.length) return;
    state.openPalette({ targets: sessions, targetType: 'session', mode: 'snooze' });
    noteRowVerbActed(false);
  }, [pathname, isOnInboxPage]));

  useShortcutAction('session.rename', useCallback(() => {
    runVerb(false, (id) => {
      const store = useInboxStore.getState();
      const session = store.sessions[id] ?? store.conversations[id];
      if (session) store.openSessionRename(session);
    });
  }, [runVerb]));

  useShortcutAction('session.moveToBucket', useCallback(() => {
    runVerb(false, (id) => triage.label(id));
  }, [runVerb, triage]));

  useShortcutAction('view.switch', useCallback(() => {
    // Straight into the palette's label/project view submenu (no targets —
    // the filter is global panel state, not a per-session action).
    useInboxStore.getState().openPalette({ mode: 'view' });
  }, []));

  useShortcutAction('ui.toggleShortcutsHelp', useCallback(() => {
    useInboxStore.getState().toggleShortcutsPanel();
  }, []));

  useShortcutAction('ui.openTours', useCallback(() => {
    const s = useInboxStore.getState();
    s.setToursPanelOpen(!s.toursPanelOpen);
  }, []));

  // The feature guides (tours/guides), on or off: they are how a team decides.
  useShortcutAction('ui.guideOrg', useCallback(() => { startTour('org-guide', { replay: true }); }, []));
  useShortcutAction('ui.guideFlows', useCallback(() => { startTour('flows-guide', { replay: true }); }, []));

  useShortcutAction('ui.openSettings', useCallback(() => {
    const s = useInboxStore.getState();
    if (s.settingsModalSection) s.closeSettingsModal();
    else s.openSettingsModal();
  }, []));

  useShortcutAction('ui.zenToggle', useCallback(() => {
    const store = useInboxStore.getState();
    const zen = store.clientState.ui?.zen_mode ?? false;
    if (!zen) checkMilestone('m-first-zen');
    store.setZenNavOpen(false);
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

  useShortcutAction('nav.ops', useCallback(() => { router.push("/ops"); }, [router]));
  useShortcutAction('ui.addressBar', useCallback(() => { toggleAppAddressBar(); }, []));
  // Modern's Back walks the tab's trail, as the back control in every header does.
  useShortcutAction('nav.back', useCallback(() => navBack((p) => router.push(p)), [router]));
  useShortcutAction('nav.forward', useCallback(() => { window.history.forward(); }, []));

  useShortcutAction('compose.focus', useCallback(() => { focusComposer(); }, []));
  useShortcutAction('task.create', useCallback(() => { useInboxStore.getState().openCreateModal("task"); }, []));

  useShortcutAction('sidebar.toggleLeft', useCallback(() => {
    const store = useInboxStore.getState();
    if (store.clientState.ui?.zen_mode) store.setZenNavOpen(!store.zenNavOpen);
    else store.setNavCollapsed(!selectNavCollapsed(store));
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

  // ui.undo, ui.redo and ui.undoHistory, plus the held-modifier peek of the timeline.
  useUndoWalk();

}
