import { useEffect, useRef, useCallback, useState } from "react";
import { useInboxStore, InboxSession } from "../store/inboxStore";

export type SwitcherState = {
  open: boolean;
  selectedIndex: number;
  mruSessions: InboxSession[];
};

const CLOSED: SwitcherState = { open: false, selectedIndex: 0, mruSessions: [] };

export function useSessionSwitcher() {
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const touchMru = useInboxStore((s) => s.touchMru);

  const [renderState, setRenderState] = useState<SwitcherState>(CLOSED);

  const ctrlHeld = useRef(false);
  const tabCount = useRef(0);
  const pending = useRef(false);
  const overlayOpen = useRef(false);
  const selectedIdx = useRef(0);
  const mruSnap = useRef<InboxSession[]>([]);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getMruSessions = useCallback((): InboxSession[] => {
    const { sessions, mruStack, sortedSessions } = useInboxStore.getState();
    const ordered: InboxSession[] = [];
    const seen = new Set<string>();
    for (const id of mruStack) {
      const s = sessions[id];
      if (s) { ordered.push(s); seen.add(id); }
    }
    for (const s of sortedSessions()) {
      if (!seen.has(s._id)) ordered.push(s);
    }
    return ordered;
  }, []);

  const commit = useCallback((sessions: InboxSession[], idx: number) => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    const target = sessions[idx];
    if (target) {
      const { sessions: all } = useInboxStore.getState();
      if (all[target._id]) { setCurrentSession(target._id); touchMru(target._id); }
    }
    overlayOpen.current = false;
    selectedIdx.current = 0;
    mruSnap.current = [];
    tabCount.current = 0;
    pending.current = false;
    ctrlHeld.current = false;
    setRenderState(CLOSED);
  }, [setCurrentSession, touchMru]);

  const updateRender = useCallback(() => {
    setRenderState({
      open: overlayOpen.current,
      selectedIndex: selectedIdx.current,
      mruSessions: mruSnap.current,
    });
  }, []);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
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
    };

    const onUp = (e: KeyboardEvent) => {
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
    };

    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      if (peekTimer.current) clearTimeout(peekTimer.current);
    };
  }, [getMruSessions, commit, updateRender]);

  return renderState;
}
