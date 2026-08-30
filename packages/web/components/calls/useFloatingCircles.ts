// The machinery every floating circle window shares, whichever circles it is
// showing. Two windows draw circles over the person's work — the minimized
// call (CallFaces) and the idle presence overlay (PresenceFaces) — and both
// have to get the same two things right:
//
// CLICK-THROUGH. The window is a rectangle, the product is a few circles. It
// ignores the mouse by default, and the renderer — the only side that knows
// where the circles are — lifts that while the pointer is over one. Get it
// wrong and an invisible pane eats clicks meant for the person's editor.
//
// SIZE. The window is exactly as big as its circles, plus what hovering adds:
// the chrome overlays the circles rather than sitting under them, so away from
// the pointer the window reserves nothing.
//
// Which window the machinery drives is the caller's: each hands in its own
// shell bridge, so the call window's circles keep talking to the call window
// and the overlay's to the overlay window, through one implementation.
import { useCallback, useRef, useState } from "react";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { hitsInteractive, type HitRegion } from "../../lib/calls/faceCrop";

/** The three runtime switches a see-through window asks of its shell. */
export type FloatingBridge = {
  /** Lift or restore click-through while the pointer is over a circle. */
  setInteractive: (on: boolean) => void;
  /** Keep the window the size of its circles. */
  setContentSize: (size: { width: number; height: number }) => void;
  /** Held on a circle, the window follows the cursor. */
  setDragging: (on: boolean) => void;
};

export function useFloatingCircles(opts: {
  /** How big the window has to be, given whether the pointer is in it. Read
   *  through a ref, so only `shapeSig` and the hover decide when to re-ask. */
  sizeFor: (hovered: boolean) => { width: number; height: number };
  /** A signature of everything that moves the circles: mode, count, tier. When
   *  it changes the window is resized and the hit regions are re-measured. */
  shapeSig: string;
  bridge: FloatingBridge;
  /** How long the chrome outlives a pointer that left the circles. */
  hideDelayMs?: number;
}) {
  const { shapeSig, bridge, hideDelayMs = 1500 } = opts;
  const [hovered, setHovered] = useState(false);

  const sizeForRef = useRef(opts.sizeFor);
  sizeForRef.current = opts.sizeFor;

  // ── The window is exactly as big as its circles ─────────────────────────
  useWatchEffect(() => {
    bridge.setContentSize(sizeForRef.current(hovered));
  }, [shapeSig, hovered]);

  // ── Click-through ───────────────────────────────────────────────────────
  //
  // Measured from the DOM rather than computed from the layout constants: the
  // circles are what the person sees, so the circles are what the hit test has
  // to agree with. Re-measured when the shape of the window changes, never per
  // mouse move — reading a rect per move per circle would force layout at the
  // pointer's rate on the one window that must stay cheap.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const regionsRef = useRef<HitRegion[]>([]);
  // Declared up here because the click-through test below reads it: a drag in
  // progress is the one state in which the window must keep taking the mouse.
  const dragging = useRef(false);
  const interactiveRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const regions: HitRegion[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-face-hit]"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) regions.push({ kind: "circle", cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 });
    }
    const chrome = root.querySelector<HTMLElement>("[data-chrome-hit]");
    if (chrome) {
      const r = chrome.getBoundingClientRect();
      if (r.width > 0) regions.push({ kind: "rect", x: r.left, y: r.top, width: r.width, height: r.height });
    }
    regionsRef.current = regions;
  }, []);
  // The window resizes itself a frame after the shape changes, so measure on
  // that — and once more when the chrome appears, since it is a region of its
  // own that has to take the click that follows the hover.
  useWatchEffect(() => {
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [measure, shapeSig, hovered]);
  useEventListener("resize", measure);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHovered(false);
  }, []);

  useEventListener("mousemove", (e: MouseEvent) => {
    // Mid-drag the window is following the cursor, so the pointer never really
    // leaves the circle — but if a fast flick made this test say otherwise, the
    // window would stop taking mouse events and the pointer-up that ends the
    // drag would never arrive. The window would then follow the cursor until
    // the shell's own expiry. So a drag holds interactivity open.
    if (dragging.current) return;
    const hit = hitsInteractive(regionsRef.current, e.clientX, e.clientY);
    if (hit !== interactiveRef.current) {
      interactiveRef.current = hit;
      bridge.setInteractive(hit);
    }
    setHovered(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Over a circle, the chrome stays. Anywhere else in the window it is on its
    // way out — including when the pointer leaves through the transparent
    // margin, which is the last event this window ever sees of that gesture.
    hideTimer.current = hit ? null : setTimeout(hide, hideDelayMs);
  });
  useEventListener("mouseleave", hide, document);

  // ── Dragging a circle moves the window ──────────────────────────────────
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    bridge.setDragging(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bridge is a per-window constant
  }, []);
  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    bridge.setDragging(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bridge is a per-window constant
  }, []);

  return { rootRef, hovered, startDrag, endDrag };
}
