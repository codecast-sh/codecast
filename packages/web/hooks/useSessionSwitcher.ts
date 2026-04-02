import { useRef, useCallback, useState } from "react";
import { useInboxStore, InboxSession, getProjectName } from "../store/inboxStore";
import { useEventListener } from "./useEventListener";
import { usePathname } from "next/navigation";
import { isInboxSessionView } from "../lib/inboxRouting";

export type SwitcherState = {
  open: boolean;
  selectedIndex: number;
  mruSessions: InboxSession[];
};

const CLOSED: SwitcherState = { open: false, selectedIndex: 0, mruSessions: [] };

export function useSessionSwitcher() {
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const selectPanelSession = useInboxStore((s) => s.selectPanelSession);
  const touchMru = useInboxStore((s) => s.touchMru);
  const pathname = usePathname();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);

  const [renderState, setRenderState] = useState<SwitcherState>(CLOSED);

  const ctrlHeld = useRef(false);
  const tabCount = useRef(0);
  const pending = useRef(false);
  const overlayOpen = useRef(false);
  const selectedIdx = useRef(0);
  const mruSnap = useRef<InboxSession[]>([]);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getMruSessions = useCallback((): InboxSession[] => {
    const { sessions, mruStack, sortedSessions, activeProjectFilter } = useInboxStore.getState();
    const matchesFilter = (s: InboxSession) =>
      !activeProjectFilter || getProjectName(s.git_root, s.project_path) === activeProjectFilter;
    const ordered: InboxSession[] = [];
    const seen = new Set<string>();
    for (const id of mruStack) {
      const s = sessions[id];
      if (s && matchesFilter(s)) { ordered.push(s); seen.add(id); }
    }
    for (const s of sortedSessions()) {
      if (!seen.has(s._id) && matchesFilter(s)) ordered.push(s);
    }
    return ordered;
  }, []);

  const commit = useCallback((sessions: InboxSession[], idx: number) => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    const target = sessions[idx];
    if (target) {
      const { sessions: all } = useInboxStore.getState();
      if (all[target._id]) {
        if (isOnInboxPage) setCurrentSession(target._id);
        else selectPanelSession(target._id);
        touchMru(target._id);
      }
    }
    overlayOpen.current = false;
    selectedIdx.current = 0;
    mruSnap.current = [];
    tabCount.current = 0;
    pending.current = false;
    ctrlHeld.current = false;
    setRenderState(CLOSED);
  }, [isOnInboxPage, setCurrentSession, selectPanelSession, touchMru]);

  const updateRender = useCallback(() => {
    setRenderState({
      open: overlayOpen.current,
      selectedIndex: selectedIdx.current,
      mruSessions: mruSnap.current,
    });
  }, []);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Control") { ctrlHeld.current = true; return; }

    if (e.key === "Tab" && (ctrlHeld.current || e.ctrlKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (!mruSnap.current.length || tabCount.current === 0) {
        mruSnap.current = getMruSessions();
      }
      const mru = mruSnap.current;
      if (mru.length < 2) return;

      if (e.shiftKey) {
        if (overlayOpen.current) {
          selectedIdx.current = Math.max(0, selectedIdx.current - 1);
          updateRender();
        }
        return;
      }

      tabCount.current++;

      if (tabCount.current === 1) {
        pending.current = true;
        selectedIdx.current = 1;
        peekTimer.current = setTimeout(() => {
          peekTimer.current = null;
          if (pending.current && ctrlHeld.current) {
            pending.current = false;
            overlayOpen.current = true;
            updateRender();
          }
        }, 200);
        return;
      }

      if (tabCount.current === 2) {
        if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
        pending.current = false;
        overlayOpen.current = true;
        selectedIdx.current = Math.min(2, mru.length - 1);
        updateRender();
        return;
      }

      selectedIdx.current = Math.min(selectedIdx.current + 1, mru.length - 1);
      updateRender();
      return;
    }
  }, undefined, { capture: true });

  useEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === "Control") {
      ctrlHeld.current = false;

      if (pending.current) {
        if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
        const mru = mruSnap.current.length >= 2 ? mruSnap.current : getMruSessions();
        if (mru.length >= 2) {
          commit(mru, 1);
        } else {
          pending.current = false;
          tabCount.current = 0;
        }
        return;
      }

      if (overlayOpen.current) {
        commit(mruSnap.current, selectedIdx.current);
        return;
      }

      tabCount.current = 0;
    }
  }, undefined, { capture: true });

  return renderState;
}
