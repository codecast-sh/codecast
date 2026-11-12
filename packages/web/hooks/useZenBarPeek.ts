"use client";

// The zen top bar's peek: resting the pointer on the window's top edge slides
// the bar down, and leaving it (with none of its menus open) slides it away.
// The edge strip itself is ZenTopEdge (components/ZenBarPeek.tsx).

import { useCallback, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useWatchEffect } from "./useWatchEffect";

// Same dwell as the side peeks (EdgePeek): a pointer passing over the top edge
// on its way to the menu bar or another window opens nothing.
const PEEK_DWELL_MS = 280;
// How often a bar held open by one of its own menus checks whether to go.
const HOLD_CHECK_MS = 300;

/** A menu, popover or picker opened from the bar keeps it down: their layers
 *  portal outside the bar, so the pointer moving into one is not a leave. */
function barHoldsMenu(bar: HTMLElement | null): boolean {
  return !!bar?.querySelector('[aria-expanded="true"], [data-state="open"]');
}

export function useZenBarPeek(enabled: boolean, barRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const over = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // The bar goes once the pointer is off it and none of its menus is open.
  const closeWhenFree = useCallback(() => {
    clear();
    if (over.current) return;
    if (barHoldsMenu(barRef.current)) {
      timer.current = setTimeout(closeWhenFree, HOLD_CHECK_MS);
      return;
    }
    setOpen(false);
  }, [barRef]);
  const onEdgeEnter = useCallback((e: MouseEvent) => {
    clear();
    if (e.buttons !== 0) return;
    timer.current = setTimeout(() => setOpen(true), PEEK_DWELL_MS);
  }, []);
  const onEdgeLeave = useCallback(() => {
    if (!open) clear();
  }, [open]);
  const onBarEnter = useCallback(() => {
    over.current = true;
    clear();
  }, []);
  const onBarLeave = useCallback(() => {
    over.current = false;
    closeWhenFree();
  }, [closeWhenFree]);
  // Leaving zen (or the bar becoming an app window's) drops the peek.
  useWatchEffect(() => {
    if (!enabled) {
      clear();
      over.current = false;
      setOpen(false);
    }
  }, [enabled]);
  useWatchEffect(() => () => clear(), []);
  return { open: enabled && open, onEdgeEnter, onEdgeLeave, onBarEnter, onBarLeave };
}
