"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useInboxStore, isSessionWaitingForInput } from "../store/inboxStore";
import { isInboxSessionView } from "../lib/inboxRouting";
import { useShortcutAction } from "./ShortcutProvider";
import { performUndo, performRedo } from "../store/undoStack";
import { animatedHideSession, undoableDeferSession, undoablePinSession } from "../store/undoActions";
import { checkMilestone } from "../tips/useTips";

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
      store.selectPanelSession(ordered[(idx + 1) % ordered.length]._id);
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
      store.selectPanelSession(ordered[(idx - 1 + ordered.length) % ordered.length]._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.jumpIdle', useCallback(() => {
    const store = useInboxStore.getState();
    const ordered = store.visualOrder();
    const first = ordered.find(s => isSessionWaitingForInput(s));
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
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (currentId) {
      const session = store.sessions[currentId];
      if (session && !session.is_pinned) checkMilestone('m-first-pin');
      undoablePinSession(currentId);
    }
  }, [isOnInboxPage]));

  // Shared body of the stash/kill chords; the only difference is the mode.
  // The kill itself happens SERVER-side on the hide data transition
  // (dispatch.applyPatches), so neither handler asks for it.
  const hideCurrent = useCallback((mode: "stash" | "kill") => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    if (mode === "stash") checkMilestone('m-first-stash');
    if (!isOnInboxPage) {
      const ordered = store.visualOrder();
      const idx = ordered.findIndex(s => s._id === currentId);
      const next = ordered.slice(idx + 1).find(s => s._id !== currentId)
        ?? ordered.find(s => s._id !== currentId);
      if (next) store.selectPanelSession(next._id);
    }
    animatedHideSession(currentId, mode);
  }, [isOnInboxPage]);

  useShortcutAction('session.stash', useCallback(() => hideCurrent("stash"), [hideCurrent]));

  useShortcutAction('session.kill', useCallback(() => hideCurrent("kill"), [hideCurrent]));

  useShortcutAction('session.deferAdvance', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    const ordered = store.visualOrder();
    const idx = ordered.findIndex(s => s._id === currentId);
    const next = ordered[idx + 1] ?? ordered.find(s => s._id !== currentId);
    undoableDeferSession(currentId);
    if (next) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.rename', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (currentId) useInboxStore.setState({ renamingSessionId: currentId });
  }, [isOnInboxPage]));

  useShortcutAction('session.moveToBucket', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
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

  useShortcutAction('compose.focus', useCallback(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-chat-input]');
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
  }, []));

  useShortcutAction('sidebar.toggleLeft', useCallback(() => {
    const store = useInboxStore.getState();
    const collapsed = store.clientState.ui?.sidebar_collapsed ?? false;
    store.updateClientUI({ sidebar_collapsed: !collapsed });
  }, []));

  useShortcutAction('sidebar.toggleRight', useCallback(() => {
    useInboxStore.getState().toggleSidePanel();
  }, []));

  useShortcutAction('ui.undo', useCallback(() => {
    return performUndo() || false;
  }, []));

  useShortcutAction('ui.redo', useCallback(() => {
    return performRedo() || false;
  }, []));

}
