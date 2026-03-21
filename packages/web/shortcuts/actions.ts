"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { isInboxSessionView } from "../lib/inboxRouting";
import { useShortcutAction } from "./ShortcutProvider";

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
      const sorted = store.sortedSessions();
      if (sorted.length === 0) return;
      const idx = sorted.findIndex(s => s._id === store.sidePanelSessionId);
      store.selectPanelSession(sorted[(idx + 1) % sorted.length]._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.prev', useCallback(() => {
    const store = useInboxStore.getState();
    if (isOnInboxPage) {
      store.navigateUp();
    } else {
      const sorted = store.sortedSessions();
      if (sorted.length === 0) return;
      const idx = sorted.findIndex(s => s._id === store.sidePanelSessionId);
      store.selectPanelSession(sorted[(idx - 1 + sorted.length) % sorted.length]._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.jumpIdle', useCallback(() => {
    const store = useInboxStore.getState();
    const sorted = store.sortedSessions();
    const first = sorted.find(s => s.is_idle && s.message_count > 0 && !s.is_pinned);
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
    const sorted = store.sortedSessions();
    const idx = sorted.findIndex(s => s._id === currentId);
    const next = sorted[idx + 1] ?? sorted.find(s => s._id !== currentId);
    store.stashSession(currentId);
    if (next) {
      if (isOnInboxPage) store.setCurrentSession(next._id);
      else store.selectPanelSession(next._id);
    }
  }, [isOnInboxPage]));

  useShortcutAction('session.deferAdvance', useCallback(() => {
    const store = useInboxStore.getState();
    const currentId = isOnInboxPage ? store.currentSessionId : store.sidePanelSessionId;
    if (!currentId) return;
    const sorted = store.sortedSessions();
    const idx = sorted.findIndex(s => s._id === currentId);
    const next = sorted[idx + 1] ?? sorted.find(s => s._id !== currentId);
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

  useShortcutAction('ui.zenToggle', useCallback(() => {
    const store = useInboxStore.getState();
    const zen = store.clientState.ui?.zen_mode ?? false;
    store.updateClientUI({ zen_mode: !zen });
  }, []));

  useShortcutAction('nav.inbox', useCallback(() => {
    router.push("/inbox");
  }, [router]));
}
