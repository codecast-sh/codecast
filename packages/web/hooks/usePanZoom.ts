import { useCallback, useRef, useState } from "react";
import { useEventListener } from "./useEventListener";
import { useWatchEffect } from "./useWatchEffect";

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const WHEEL_OPTS: AddEventListenerOptions = { passive: false };

type View = { scale: number; x: number; y: number };
const IDENTITY: View = { scale: 1, x: 0, y: 0 };

// Safari's trackpad pinch arrives as non-standard gesture events, not as
// ctrl+wheel the way Chromium reports it.
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

// Pan and zoom for one image in a viewer. A trackpad pinch (ctrl+wheel in
// Chromium, gesture events in Safari) or ctrl+wheel on a mouse zooms around the
// pointer; while zoomed, two-finger scroll and dragging pan. `surface` is the
// element that catches the wheel (the whole overlay, so a pinch anywhere
// works); `imageProps` go on the <img>, or on a box around it that also
// carries things which must move with the picture (the gallery's note pins). The view resets whenever `resetKey`
// changes (the viewer paged to another image).
export function usePanZoom(resetKey: unknown) {
  const [view, setView] = useState<View>(IDENTITY);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const imgRef = useRef<HTMLElement | null>(null);
  const reset = useCallback(() => setView(IDENTITY), []);
  useWatchEffect(reset, [resetKey, reset]);

  // Scale to `next` keeping the image point under (px, py) where it is. With
  // transform-origin at the centre, the transformed box's centre is the layout
  // centre plus the translation, so the shift is the pointer's offset from that
  // centre times the fraction of growth.
  const zoomAt = useCallback((next: (s: number) => number, px: number, py: number) => {
    const rect = imgRef.current?.getBoundingClientRect();
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next(v.scale)));
      if (scale === MIN_SCALE) return IDENTITY;
      if (!rect) return { ...v, scale };
      const k = 1 - scale / v.scale;
      return { scale, x: v.x + (px - (rect.left + rect.width / 2)) * k, y: v.y + (py - (rect.top + rect.height / 2)) * k };
    });
  }, []);

  useEventListener("wheel", useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = Math.max(-50, Math.min(50, e.deltaY));
      zoomAt((s) => s * Math.exp(-delta * 0.01), e.clientX, e.clientY);
    } else if (view.scale > 1) {
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    }
  }, [zoomAt, view.scale]), surface, WHEEL_OPTS);

  const gestureStart = useRef(1);
  useEventListener("gesturestart" as "wheel", useCallback((e: Event) => {
    e.preventDefault();
    gestureStart.current = view.scale;
  }, [view.scale]), surface, WHEEL_OPTS);
  useEventListener("gesturechange" as "wheel", useCallback((e: Event) => {
    e.preventDefault();
    const g = e as GestureEvent;
    zoomAt(() => gestureStart.current * g.scale, g.clientX, g.clientY);
  }, [zoomAt]), surface, WHEEL_OPTS);

  // Drag to pan while zoomed. A drag that moved must not also count as a click
  // on the image (the gallery pins a note on click).
  const drag = useRef<{ id: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (view.scale <= 1 || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false };
  }, [view]);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.x + dx, y: d.y + dy }));
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    suppressClick.current = d.moved;
    drag.current = null;
  }, []);
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  const zoomed = view.scale > 1;
  // A callback ref fits both an <img> and a box around one.
  const setImg = useCallback((el: HTMLElement | null) => { imgRef.current = el; }, []);
  const imageProps = {
    ref: setImg,
    draggable: false,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClickCapture,
    style: {
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
      cursor: zoomed ? (drag.current?.moved ? "grabbing" : "grab") : undefined,
      touchAction: "none",
    } as React.CSSProperties,
  };

  return { surfaceRef: setSurface, imageProps, scale: view.scale, zoomed, reset };
}
