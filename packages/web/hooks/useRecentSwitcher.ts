import { useRef, useCallback, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useEventListener } from "./useEventListener";
import { usePathname } from "next/navigation";
import { isInboxSessionView } from "../lib/inboxRouting";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { useOpenRecentVisit } from "./useOpenRecentVisit";

export type SwitcherState = {
  open: boolean;
  selectedIndex: number;
  items: ResolvedVisit[];
};

const CLOSED: SwitcherState = { open: false, selectedIndex: 0, items: [] };

// Ctrl+Tab walks everything you recently looked at — sessions, label and
// project views, tasks, docs, plans, channels, pages — in the order you looked
// at them. Same list as the header's Recently Viewed menu and the palette's top
// group, capped at the persisted recents window.
const SWITCHER_LIMIT = 30;

export function useRecentSwitcher() {
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const selectPanelSession = useInboxStore((s) => s.selectPanelSession);
  const pathname = usePathname();
  const inboxSource = useInboxStore((s) => s.currentConversation?.source);
  const isOnInboxPage = isInboxSessionView(pathname, inboxSource);

  // A session opens in place on the inbox and in the side panel elsewhere, so a
  // quick Ctrl+Tab peeks at a session without leaving the page you are on.
  // Something only the conversation cache knows (opened from search, never in
  // the inbox) goes through the navigation request the sidebar uses.
  const openSession = useCallback((id: string) => {
    const store = useInboxStore.getState();
    if (!store.sessions[id]) {
      store.requestNavigate(id, { showMySessions: false });
      return;
    }
    // setCurrentSession / selectPanelSession record the view (MRU + divider
    // anchor) themselves — no separate touchMru needed here.
    if (isOnInboxPage) setCurrentSession(id);
    else selectPanelSession(id);
  }, [isOnInboxPage, setCurrentSession, selectPanelSession]);
  const openVisit = useOpenRecentVisit(openSession);

  const [renderState, setRenderState] = useState<SwitcherState>(CLOSED);

  const ctrlHeld = useRef(false);
  const tabCount = useRef(0);
  const pending = useRef(false);
  const overlayOpen = useRef(false);
  const selectedIdx = useRef(0);
  const snap = useRef<ResolvedVisit[]>([]);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getRecents = useCallback(
    (): ResolvedVisit[] => resolveRecentVisits(useInboxStore.getState(), SWITCHER_LIMIT),
    [],
  );

  const commit = useCallback((items: ResolvedVisit[], idx: number) => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    const target = items[idx];
    if (target) openVisit(target);
    overlayOpen.current = false;
    selectedIdx.current = 0;
    snap.current = [];
    tabCount.current = 0;
    pending.current = false;
    ctrlHeld.current = false;
    setRenderState(CLOSED);
  }, [openVisit]);

  const updateRender = useCallback(() => {
    setRenderState({
      open: overlayOpen.current,
      selectedIndex: selectedIdx.current,
      items: snap.current,
    });
  }, []);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Control") { ctrlHeld.current = true; return; }

    if (e.key === "Tab" && (ctrlHeld.current || e.ctrlKey)) {
      e.preventDefault();

      if (!snap.current.length || tabCount.current === 0) {
        snap.current = getRecents();
      }
      const items = snap.current;
      if (items.length < 2) return;

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
        selectedIdx.current = Math.min(2, items.length - 1);
        updateRender();
        return;
      }

      selectedIdx.current = Math.min(selectedIdx.current + 1, items.length - 1);
      updateRender();
      return;
    }
  }, undefined);

  useEventListener("keyup", (e: KeyboardEvent) => {
    if (e.key === "Control") {
      ctrlHeld.current = false;

      if (pending.current) {
        if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
        const items = snap.current.length >= 2 ? snap.current : getRecents();
        if (items.length >= 2) {
          commit(items, 1);
        } else {
          pending.current = false;
          tabCount.current = 0;
        }
        return;
      }

      if (overlayOpen.current) {
        commit(snap.current, selectedIdx.current);
        return;
      }

      tabCount.current = 0;
    }
  }, undefined);

  return renderState;
}
