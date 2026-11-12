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

import { useState, type MouseEvent } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { guardZenCorner, zenCornerWidth } from "../lib/desktop";

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
