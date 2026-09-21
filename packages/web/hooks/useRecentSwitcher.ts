import { useRef, useCallback, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useEventListener } from "./useEventListener";
import { resolveRecentVisits, type ResolvedVisit } from "../lib/recentVisits";
import { useOpenRecentVisit } from "./useOpenRecentVisit";
import { useOpenSession } from "./useOpenSession";
import { useShortcutAction } from "../shortcuts";

export type SwitcherState = {
  open: boolean;
  // walk: Ctrl is held and Tab moves the frame; releasing Ctrl opens it.
  // search: the field is live; Enter opens, Escape closes, Ctrl does nothing.
  mode: "walk" | "search";
  selectedIndex: number;
  items: ResolvedVisit[];
};

const CLOSED: SwitcherState = { open: false, mode: "walk", selectedIndex: 0, items: [] };

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
  const searching = useRef(false);
  const selectedIdx = useRef(0);
  const snap = useRef<ResolvedVisit[]>([]);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Where focus was when the search field took it (the composer, usually), so
  // closing puts the caret back.
  const returnFocus = useRef<HTMLElement | null>(null);

  const getRecents = useCallback(
    (): ResolvedVisit[] => resolveRecentVisits(useInboxStore.getState(), SWITCHER_LIMIT),
    [],
  );

  const updateRender = useCallback(() => {
    setRenderState({
      open: overlayOpen.current,
      mode: searching.current ? "search" : "walk",
      selectedIndex: selectedIdx.current,
      items: snap.current,
    });
  }, []);

  // Drop the overlay without navigating: the next Control release commits
  // nothing. Focus goes back where the search field took it from.
  const cancel = useCallback(() => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    overlayOpen.current = false;
    searching.current = false;
    selectedIdx.current = 0;
    snap.current = [];
    tabCount.current = 0;
    pending.current = false;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el && el.isConnected) el.focus();
    setRenderState(CLOSED);
  }, []);

  const commit = useCallback((items: ResolvedVisit[], idx: number) => {
    const target = items[idx];
    // Navigation moves focus itself; restoring the old element first would
    // fight it.
    returnFocus.current = null;
    cancel();
    ctrlHeld.current = false;
    if (target) openVisit(target);
  }, [cancel, openVisit]);

  // The field goes live in the open overlay, or the overlay opens with it
  // live. Either way Ctrl stops mattering: releasing it no longer navigates.
  const enterSearch = useCallback(() => {
    if (peekTimer.current) { clearTimeout(peekTimer.current); peekTimer.current = null; }
    if (!overlayOpen.current) {
      snap.current = getRecents();
      if (snap.current.length === 0) return;
      // Enter with nothing typed goes where Ctrl+Tab would: the view before
      // this one. The first row is where you already are.
      selectedIdx.current = Math.min(1, snap.current.length - 1);
      overlayOpen.current = true;
    }
    if (!searching.current) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      searching.current = true;
    }
    pending.current = false;
    tabCount.current = 0;
    updateRender();
  }, [getRecents, updateRender]);

  useShortcutAction("recents.open", useCallback(() => {
    if (searching.current) cancel();
    else enterSearch();
  }, [cancel, enterSearch]));

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Control") { ctrlHeld.current = true; return; }

    if (searching.current) {
      // The field owns the keys (cmdk: arrows, Enter). Escape closes.
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
      return;
    }

    if (e.key !== "Tab" && e.key !== "Shift" && (overlayOpen.current || pending.current)) {
      // R with Ctrl still down: the walk becomes a search, in place. On mac
      // the registry fires recents.open for the same press and lands in the
      // same place; off mac the chord is Alt+R, so this is the only way in
      // from a held walk.
      if (ctrlHeld.current && e.key.toLowerCase() === "r") {
        e.preventDefault();
        enterSearch();
        return;
      }
      // Any other key mid-walk hands the chord to whoever owns it, and
      // releasing Control afterwards must not also navigate.
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
      if (searching.current) return;

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

  // Pointer hover and the live field move the frame through cmdk.
  const setSelectedIndex = useCallback((i: number) => {
    selectedIdx.current = i;
    updateRender();
  }, [updateRender]);

  // Enter or a click in the panel.
  const select = useCallback((item: ResolvedVisit) => {
    const i = snap.current.indexOf(item);
    commit(snap.current, i >= 0 ? i : selectedIdx.current);
  }, [commit]);

  return { ...renderState, setSelectedIndex, select };
}
