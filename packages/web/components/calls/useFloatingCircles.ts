// The machinery a see-through window of circles needs, whichever circles it
// is showing: the face row in the float (FloatingFaceRow) today, the older
// shell's call circles (CallFaces) until every desktop has updated. Both
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
import { faceAt, hitsInteractive, type HitRegion } from "../../lib/calls/faceCrop";

/** The three runtime switches a see-through window asks of its shell. */
export type FloatingBridge = {
  /** Lift or restore click-through while the pointer is over a circle. */
  setInteractive: (on: boolean) => void;
  /** Keep the window the size of its circles. `pinY`, when given, is the
   *  point (CSS px from the window's top) that must not move on screen: the
   *  faces. A shell that predates it anchors by its corner instead. */
  setContentSize: (size: { width: number; height: number; pinY?: number }) => void;
  /** Held on a circle, the window follows the cursor. */
  setDragging: (on: boolean) => void;
};

export function useFloatingCircles(opts: {
  /** How big the window has to be, given whether the pointer is in it. Read
   *  through a ref, so only `shapeSig` and the hover decide when to re-ask. */
  sizeFor: (hovered: boolean) => { width: number; height: number; pinY?: number };
  /** A signature of everything that moves the circles: mode, count, tier. When
   *  it changes the window is resized and the hit regions are re-measured. */
  shapeSig: string;
  bridge: FloatingBridge;
  /** How long the chrome outlives a pointer that left the circles. */
  hideDelayMs?: number;
  /** Hovered means the pointer is ON the content (a circle, a card, the
   *  row's own box), not merely somewhere on the window's glass. For a window
   *  that keeps room for its card at all times, most of it is glass. */
  hoverContent?: boolean;
}) {
  const { shapeSig, bridge, hideDelayMs = 1500, hoverContent = false } = opts;
  const [hovered, setHovered] = useState(false);
  // The face under the pointer, from the same hit test that lifts
  // click-through. DOM mouseenter is not a reliable signal on a see-through
  // window: the shell forwards moves while it ignores the mouse, and the
  // enter that should follow when it stops ignoring it did not always come,
  // so a face opened its card on hover only some of the time.
  const [pointed, setPointed] = useState<string | null>(null);
  // Declared up here because the size effect and the click-through test read
  // it: a drag in progress is the one state in which the window must keep
  // taking the mouse, and must not be resized.
  const dragging = useRef(false);

  const sizeForRef = useRef(opts.sizeFor);
  sizeForRef.current = opts.sizeFor;

  // ── The window is exactly as big as its circles ─────────────────────────
  //
  // Never mid-drag: the shell lifts and restores the window's resizable flag
  // around a resize, and macOS ends the mouse tracking with it, so the drag
  // died a beat after it started whenever a hover grew the window under the
  // held button. The size is applied when the button comes up.
  const pendingSize = useRef(false);
  useWatchEffect(() => {
    if (dragging.current) {
      pendingSize.current = true;
      return;
    }
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
  const interactiveRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const regions: HitRegion[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-face-hit]"))) {
      const r = el.getBoundingClientRect();
      const id = el.closest<HTMLElement>("[data-face-id]")?.dataset.faceId;
      if (r.width > 0) regions.push({ kind: "circle", cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2, id });
    }
    // EVERY chrome region, not the first: the overlay draws its card and its
    // controls as separate hit rects, and a toolbar left out of this list is
    // a toolbar the person clicks straight through into the app beneath.
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-chrome-hit]"))) {
      const r = el.getBoundingClientRect();
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
  // The overlay's faces GROW when a teammate's presence changes, as a 280ms
  // transform (people.css), and rects include transforms — so the measure
  // above can land on a circle mid-scale and keep the old radius. The circles
  // stop moving at animationend, which bubbles up from the seats; measure once
  // more then. The resize backstop cannot cover this: two faces swapping tiers
  // leave the window size unchanged, so no resize ever fires.
  useEventListener("animationend", measure);
  // The card's band slides under whichever face it is about (a transition on
  // `left`), and a pinned card moves it without any resize: measure where it
  // came to rest, or its old rect keeps taking the clicks.
  useEventListener("transitionend", measure);
  const measureSoon = useCallback(() => {
    requestAnimationFrame(measure);
  }, [measure]);
  useEventListener("click", measureSoon);
  useWatchEffect(() => {
    measureSoon();
  }, [pointed]);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    // Never mid-drag. The window follows the cursor a tick behind it, so a
    // quick pull puts the pointer outside the glass for a moment and the
    // document fires mouseleave. Hiding then collapses the card the grip is
    // in and resizes the window under a held mouse button, and macOS ends the
    // drag's mouse tracking with it: the release never reaches the renderer,
    // and the window follows the cursor until the shell's own expiry. The
    // drag holds the chrome open the way it holds interactivity; the release
    // below arms the hide again.
    if (dragging.current) return;
    setHovered(false);
  }, []);
  const hideLater = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(hide, hideDelayMs);
  }, [hide, hideDelayMs]);

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
    setPointed(faceAt(regionsRef.current, e.clientX, e.clientY));
    // On the content keeps the chrome. A window that is exactly its circles
    // and their card counts all of itself; one that keeps room for its card
    // counts only what is drawn (a circle, a card, the row's box). While the
    // pointer rests on it, no timer runs: a timer under a still hand hid and
    // reshowed the card every 1.5s.
    const box = hoverContent ? rootRef.current?.getBoundingClientRect() : null;
    const on =
      !hoverContent ||
      hit ||
      (!!box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
    if (!on) {
      if (!hideTimer.current && hovered) hideLater();
      return;
    }
    setHovered(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  });
  useEventListener(
    "mouseleave",
    () => {
      setPointed(null);
      hide();
    },
    document,
  );

  // ── Dragging a circle moves the window ──────────────────────────────────
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    e.currentTarget.setPointerCapture(e.pointerId);
    bridge.setDragging(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bridge is a per-window constant
  }, []);
  // The drag ends on the release, wherever it lands. The grip's own handler
  // is the usual path; the document-level backstop below covers a release
  // the grip never hears — pointer capture lost to a re-render, or a release
  // delivered elsewhere — because a drag nobody ends is a window that
  // follows the cursor for thirty seconds. Ending it twice is harmless.
  const finishDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    bridge.setDragging(false);
    if (pendingSize.current) {
      pendingSize.current = false;
      bridge.setContentSize(sizeForRef.current(true));
    }
    // The pointer may be off the glass by now, and no mousemove will come to
    // say so: the chrome goes on its way out the same as after any hover.
    hideLater();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bridge is a per-window constant
  }, [hideLater]);
  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      finishDrag();
    },
    [finishDrag],
  );
  useEventListener("pointerup", finishDrag, document);
  useEventListener("pointercancel", finishDrag, document);
  useEventListener("lostpointercapture", finishDrag, document);

  return { rootRef, hovered, pointed, startDrag, endDrag };
}
