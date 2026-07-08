import { useRef, useCallback, useState } from "react";
import { useInboxStore, InboxSession } from "../store/inboxStore";
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
    // Pure most-recently-viewed: the sessions you've actually looked at, newest
    // first. No category filters (subagent / dismissed / parent / project) — the
    // switcher is "the last thing I looked at, period". Membership is just having
    // a recorded view (recordSessionView fires from every navigation path), so
    // anything you opened is reachable and never-opened sessions stay out.
    const { _lastViewedAt, sessions } = useInboxStore.getState();
    return Object.values(sessions)
      .filter((s) => _lastViewedAt[s._id] != null)
      .sort((a, b) => (_lastViewedAt[b._id] ?? 0) - (_lastViewedAt[a._id] ?? 0));
  }, []);

  const commit = useCallback((sessions: InboxSession[], idx: number) => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    const target = sessions[idx];
    if (target) {
      const { sessions: all } = useInboxStore.getState();
      if (all[target._id]) {
        // setCurrentSession / selectPanelSession record the view (MRU + divider
        // anchor) themselves — no separate touchMru needed here.
        if (isOnInboxPage) setCurrentSession(target._id);
        else selectPanelSession(target._id);
      }
    }
    overlayOpen.current = false;
    selectedIdx.current = 0;
    mruSnap.current = [];
    tabCount.current = 0;
    pending.current = false;
    ctrlHeld.current = false;
    setRenderState(CLOSED);
  }, [isOnInboxPage, setCurrentSession, selectPanelSession]);

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
  }, undefined);

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
  }, undefined);

  return renderState;
}
