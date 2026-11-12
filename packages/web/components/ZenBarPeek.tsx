"use client";

// Zen's way back to the chrome. Zen hides the top bar and the sidebar and draws
// no control of its own; resting the pointer on the window's top edge slides
// the full top bar down over the page, with its usual zen toggle (now "Exit
// zen mode"), the workspace switcher and everything else on it. Leaving the
// bar slides it away again. Ctrl+. and the palette still toggle zen directly.
//
// Two desktop rules shape this (globals.css, "Anything that floats over the
// titlebar"): a drag region eats the pointer, so the edge strip and the shown
// bar are no-drag; and overlapping drag/no-drag areas resolve by document
// order, so the strip mounts last in the shell, and while the bar is down the
// page's own titlebar rows stop dragging ([data-zen-bar-open]) instead of
// winning over the bar, which sits earlier in the shell.

import { useCallback, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { guardZenCorner, zenCornerWidth } from "../lib/desktop";

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

/** The strip along the window's top edge that brings the bar down, and the
 *  guard that keeps page content out from under the traffic lights. Mount it
 *  LAST in the shell (see the file comment). */
export function ZenTopEdge({ onEnter, onLeave }: { onEnter: (e: MouseEvent) => void; onLeave: () => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // Whatever lands under the lights without having claimed the titlebar is
  // cleared (guardZenCorner); on the web there is no corner to keep.
  useWatchEffect(() => (el && zenCornerWidth() > 0 ? guardZenCorner(zenCornerWidth(), el) : undefined), [el]);
  return (
    <div
      ref={setEl}
      data-zen-top-edge
      data-flyout
      aria-hidden
      className="fixed inset-x-0 top-0 z-[130] hidden h-1.5 md:block"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    />
  );
}
