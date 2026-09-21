import { useRef, useCallback, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useEventListener } from "./useEventListener";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { useOpenRecentVisit } from "./useOpenRecentVisit";
import { useOpenSession } from "./useOpenSession";

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
  // The shared select-kind-aware open path (hooks/useOpenSession): in place on
  // the inbox, leave for the inbox from every other surface.
  const openSession = useOpenSession();
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

  // Drop the walk without navigating: the overlay closes and the next Control
  // release commits nothing.
  const cancel = useCallback(() => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    overlayOpen.current = false;
    selectedIdx.current = 0;
    snap.current = [];
    tabCount.current = 0;
    pending.current = false;
    setRenderState(CLOSED);
  }, []);

  const commit = useCallback((items: ResolvedVisit[], idx: number) => {
    const target = items[idx];
    cancel();
    ctrlHeld.current = false;
    if (target) openVisit(target);
  }, [cancel, openVisit]);

  const updateRender = useCallback(() => {
    setRenderState({
      open: overlayOpen.current,
      selectedIndex: selectedIdx.current,
      items: snap.current,
    });
  }, []);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Control") { ctrlHeld.current = true; return; }

    // Any other key mid-walk hands the chord to whoever owns it — Ctrl+R with
    // Ctrl still down opens the searchable recents list (recents.open) — and
    // releasing Control afterwards must not also navigate.
    if (e.key !== "Tab" && e.key !== "Shift" && (overlayOpen.current || pending.current)) {
      cancel();
      return;
    }

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
