import { type SurfaceShape, type DragHandles, isSurfaceChromeTarget, HandleContext } from "../../lib/calls/surfaceHandles";
// ONE NODE FOR EVERY SHAPE THE CALL TAKES IN THE CORNER.
//
// The strip a burst draws, the pill, and the floating dock window are one
// element with three contents, mounted once for as long as there is a live room
// and never torn down in between. That is what makes the upgrade honest: a
// burst becoming a call is one card changing shape (useSurfaceMorph), not one
// surface dying and another being born somewhere else on the screen.
//
// IT IS ANCHORED TO A CORNER, NOT PLACED AT A POINT. Everything here is an
// offset from the bottom-right edge of the viewport, clamped on every layout
// (callSurfacePlacement) — which is the whole of the off-screen bug: the old
// dock froze a left/top point read from `window.innerWidth` at the moment of
// the upgrade, and a window narrowed afterwards left it outside the screen with
// nothing to bring it back.
//
// The root is INVISIBLE. It has no border, no background and no shadow: the
// card is whatever the content draws. That keeps a 1px border and a 12px radius
// from being stretched by the morph, and it means neither the strip nor the
// dock has to know an animation exists.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEventListener } from "../../hooks/useEventListener";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  DOCK_MIN,
  DOCK_SIZE,
  HOME_CORNER,
  clampCorner,
  clampSize,
  savePlacement,
  savedPlacement,
  type Corner,
  type Size,
} from "./callSurfacePlacement";
import { useSurfaceMorph } from "./useSurfaceMorph";
import "./callSurface.css";

type Placement = { corner: Corner; size: Size };

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function CallSurfaceRoot({ shape, children }: { shape: SurfaceShape; children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const leavingRef = useRef<HTMLDivElement>(null);
  const { morphing, from } = useSurfaceMorph(shape, {
    root: rootRef,
    incoming: incomingRef,
    leaving: leavingRef,
  });

  // Where the person left it, for as long as the page is open. Read once, on
  // the mount that opens the room: a call that starts after one was dragged
  // opens where the dragged one was, and a reload starts at the home corner.
  const [place, setPlace] = useState<Placement>(
    () => savedPlacement() ?? { corner: HOME_CORNER, size: DOCK_SIZE },
  );

  // The outgoing content, kept exactly as long as the morph that is fading it
  // out. Frozen while one runs, or the second render of a morph would hand the
  // corpse the NEW content and crossfade the dock with itself.
  const previous = useRef<ReactNode>(null);
  useLayoutEffect(() => {
    if (!morphing) previous.current = children;
  });

  // Clamped on every layout, never once. The observer catches the surface
  // changing size under its own content (a strip growing a line of transcript),
  // the listener catches the window changing size under the surface, and both
  // stand down mid-morph — the box is animating then, and its transient size is
  // not a placement.
  const morphingRef = useRef(morphing);
  morphingRef.current = morphing;
  const reclamp = useCallback(() => {
    const el = rootRef.current;
    if (!el || morphingRef.current) return;
    const vp = viewport();
    const r = el.getBoundingClientRect();
    setPlace((p) => {
      const size = clampSize(p.size, vp);
      const corner = clampCorner(p.corner, { width: r.width, height: r.height }, vp);
      const same =
        corner.right === p.corner.right &&
        corner.bottom === p.corner.bottom &&
        size.width === p.size.width &&
        size.height === p.size.height;
      return same ? p : { corner, size };
    });
  }, []);

  useEventListener("resize", reclamp);
  useMountEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    reclamp();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // One pointer gesture, two jobs. The surface is anchored to the bottom-right
  // corner, so moving it SUBTRACTS the pointer delta from both offsets, and
  // resizing from the top-left grip adds it to the size with the corner staying
  // exactly where it is.
  const placeRef = useRef(place);
  placeRef.current = place;
  const handles = useMemo<DragHandles>(() => {
    const gesture = (
      e: ReactPointerEvent,
      apply: (p: Placement, dx: number, dy: number) => Placement,
    ) => {
      if (e.button !== 0) return;
      // The handle is the header row, and the header row has buttons on it.
      // Capturing the pointer here is what made pop-out / expand / unpin
      // look like dead chrome: click never fired.
      if (isSurfaceChromeTarget(e.target)) return;
      const target = e.currentTarget as HTMLElement;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const base = placeRef.current;
      // The window carries the gesture, not the handle: a pointer that leaves
      // the header — which is most of a drag — must not drop the surface
      // halfway. Capture is a nicety on top of that and is allowed to fail
      // (a synthetic pointer has no id to capture), never to end the drag.
      try {
        target.setPointerCapture?.(e.pointerId);
      } catch {
        /* no capture, the window listeners still see every move */
      }
      const move = (ev: PointerEvent) => {
        const vp = viewport();
        const next = apply(base, ev.clientX - x0, ev.clientY - y0);
        const size = clampSize(next.size, vp);
        setPlace({ corner: clampCorner(next.corner, size, vp), size });
      };
      const up = () => {
        try {
          target.releasePointerCapture?.(e.pointerId);
        } catch {
          /* never captured */
        }
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      e.preventDefault();
    };
    return {
      onMove: (e) =>
        gesture(e, (p, dx, dy) => ({
          size: p.size,
          corner: { right: p.corner.right - dx, bottom: p.corner.bottom - dy },
        })),
      onResize: (e) =>
        gesture(e, (p, dx, dy) => ({
          corner: p.corner,
          size: {
            width: Math.max(DOCK_MIN.width, p.size.width - dx),
            height: Math.max(DOCK_MIN.height, p.size.height - dy),
          },
        })),
    };
  }, []);

  // The drag is what the person wants remembered, so it is written on every
  // change rather than on pointer-up: a call that ends mid-drag still leaves
  // the next one where this one was put.
  useWatchEffect(() => {
    savePlacement(place.corner, place.size);
  }, [place]);

  const box: CSSProperties =
    shape === "stage"
      ? { right: 0, bottom: 0, width: "100vw", height: "100vh" }
      : {
          right: place.corner.right,
          bottom: place.corner.bottom,
          // The strip's and the pill's widths belong to the stylesheet beside
          // the cards they hold; only the dock's is state, because only the
          // dock's can be dragged.
          width: shape === "window" ? place.size.width : undefined,
          height: shape === "window" ? place.size.height : undefined,
        };

  return createPortal(
    <HandleContext.Provider value={handles}>
      <div
        ref={rootRef}
        className="call-surface-root"
        data-shape={shape}
        data-morphing={morphing || undefined}
        style={box}
      >
        {/* Only when there is something to show: the stage draws its own
            full-screen surface, and an empty layer over the viewport would
            swallow every click meant for it. */}
        {children ? (
          <div ref={incomingRef} className="call-surface-layer">
            {children}
          </div>
        ) : null}
        {morphing && previous.current ? (
          <div
            ref={leavingRef}
            className="call-surface-layer call-surface-leaving"
            style={from ? { width: from.width, height: from.height } : undefined}
            aria-hidden="true"
          >
            {previous.current}
          </div>
        ) : null}
      </div>
    </HandleContext.Provider>,
    document.body,
  );
}
