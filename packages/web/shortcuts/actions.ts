"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId, isSessionWaitingForInput } from "../store/inboxStore";
import { isInboxSessionView } from "../lib/inboxRouting";
import { useShortcutAction } from "./ShortcutProvider";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

const api = _typedApi as any;

export function useGlobalShortcutActions() {
  const pathname = usePathname();
  const router = useRouter();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);
  const killSessionMutation = useMutation(api.conversations.killSession);

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
    const sorted = store.sortedSessions();
    const first = sorted.find(s => isSessionWaitingForInput(s));
    if (!first) return;
    if (isOnInboxPage) store.setCurrentSession(first._id);
    else store.selectPanelSession(first._id);
  }, [isOnInboxPage]));

  useShortcutAction('session.jumpPinned', useCallback(() => {
    const store = useInboxStore.getState();
    const sorted = store.sortedSessions();
    const first = sorted.find(s => s.is_pinned);
    if (!first) return;
    if (isOnInboxPage) store.setCurrentSession(first._id);
    else store.selectPanelSession(first._id);
  }, [isOnInboxPage]));

  useShortcutAction('session.pin', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (currentId) store.pinSession(currentId);
  }, [isOnInboxPage]));

  useShortcutAction('session.stash', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    const ordered = store.visualOrder();
    const idx = ordered.findIndex(s => s._id === currentId);
    const next = ordered[idx + 1] ?? ordered.find(s => s._id !== currentId);
    store.stashSession(currentId);
    if (next && useInboxStore.getState().sessions[next._id]) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.kill', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    const convexId = store.getConvexId(currentId);
    if (convexId && isConvexId(convexId)) {
      killSessionMutation({ conversation_id: convexId as Id<"conversations">, mark_completed: true }).catch(() => {});
    }
    const ordered = store.visualOrder();
    const idx = ordered.findIndex(s => s._id === currentId);
    const next = ordered[idx + 1] ?? ordered.find(s => s._id !== currentId);
    store.stashSession(currentId);
    if (next && useInboxStore.getState().sessions[next._id]) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
  }, [isOnInboxPage, killSessionMutation]));

  useShortcutAction('session.deferAdvance', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    const ordered = store.visualOrder();
    const idx = ordered.findIndex(s => s._id === currentId);
    const next = ordered[idx + 1] ?? ordered.find(s => s._id !== currentId);
    store.deferSession(currentId);
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

  useShortcutAction('ui.toggleShortcutsHelp', useCallback(() => {
    useInboxStore.getState().toggleShortcutsPanel();
  }, []));

  useShortcutAction('ui.zenToggle', useCallback(() => {
    const store = useInboxStore.getState();
    const zen = store.clientState.ui?.zen_mode ?? false;
    store.updateClientUI({ zen_mode: !zen });
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
}
