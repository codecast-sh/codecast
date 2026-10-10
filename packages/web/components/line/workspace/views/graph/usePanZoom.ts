// Pan and zoom for the Graph view (line-workspace.md LW1), Studio's feel: a
// wheel or two fingers pan, a pinch or ⌘ wheel zooms at the pointer, a drag on
// the background pans, and fit / center ease over 520ms. The transform is
// written straight onto the world group, never through React state, so a pan
// repaints one attribute a frame and nothing re-renders.
import { useCallback, useMemo, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "../../../../../lib/reducedMotion";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";

export type View = { x: number; y: number; k: number };
export type Box = { x: number; y: number; w: number; h: number };
/** Room the chrome takes over the stage's edges, in screen px. */
export type Insets = { top: number; bottom: number; left: number; right: number };

const MIN_K = 0.25;
/** The smallest zoom a fit picks: a node's smallest words (14px, graphLayout) still read at 12px. */
export const FIT_MIN_K = 0.86;
const MAX_K = 2.2;
const EASE_MS = 520;
const DRAG_SLOP = 3;
/** Frames where the page has them (jsdom and a worker may not). */
const nextFrame = (fn: FrameRequestCallback) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : (setTimeout(() => fn(performance.now()), 16) as unknown as number));
const cancelFrame = (id: number) => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); else clearTimeout(id); };

export type PanZoom = {
  /** Fit a box (the whole graph by default) into the stage. */
  fit: (anim?: boolean, box?: Box) => void;
  /** Bring a point to the stage's reading spot at a working zoom. */
  centerOn: (x: number, y: number, anim?: boolean) => void;
  /** Zoom by a factor about the stage's center. */
  zoomBy: (f: number) => void;
  /** The stage's size now, in px. */
  size: () => { w: number; h: number };
  get: () => View;
};

export function usePanZoom(
  svgRef: RefObject<SVGSVGElement | null>,
  worldRef: RefObject<SVGGElement | null>,
  opts: { bounds: Box; insets: Insets; onBackgroundClick?: () => void },
): PanZoom {
  const t = useRef<View>({ x: 0, y: 0, k: 1 });
  const raf = useRef(0);
  const o = useRef(opts);
  o.current = opts;

  const apply = useCallback(() => {
    const v = t.current;
    worldRef.current?.setAttribute("transform", `translate(${v.x.toFixed(2)},${v.y.toFixed(2)}) scale(${v.k.toFixed(4)})`);
  }, [worldRef]);

  const tween = useCallback((to: View, anim: boolean) => {
    cancelFrame(raf.current);
    if (!anim || prefersReducedMotion()) { t.current = to; apply(); return; }
    const from = { ...t.current };
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / EASE_MS);
      const e = 1 - Math.pow(1 - p, 3);
      t.current = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      apply();
      if (p < 1) raf.current = nextFrame(step);
    };
    raf.current = nextFrame(step);
  }, [apply]);

  const size = useCallback(() => {
    const r = svgRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 0, h: r?.height ?? 0 };
  }, [svgRef]);

  const fit = useCallback((anim = true, box?: Box) => {
    const { w, h } = size();
    if (!w || !h) return;
    const B = box ?? o.current.bounds;
    const i = o.current.insets;
    const aw = Math.max(80, w - i.left - i.right);
    const ah = Math.max(80, h - i.top - i.bottom);
    // Never fit so small that its words stop reading: past FIT_MIN_K the graph keeps its size, starts at its left
    // (where a problem comes in) and top, and pans for the rest.
    const k = Math.max(FIT_MIN_K, Math.min(aw / B.w, ah / B.h, 1.2));
    const x = B.w * k > aw ? i.left - B.x * k : i.left + (aw - B.w * k) / 2 - B.x * k;
    const y = B.h * k > ah ? i.top - B.y * k : i.top + (ah - B.h * k) / 2 - B.y * k;
    tween({ x, y, k }, anim);
  }, [size, tween]);

  const centerOn = useCallback((x: number, y: number, anim = true) => {
    const { w, h } = size();
    if (!w || !h) return;
    const i = o.current.insets;
    const k = Math.min(0.95, Math.max(0.55, (w - 60) / 1080));
    tween({ x: w / 2 - x * k, y: i.top + (h - i.top - i.bottom) * 0.4 - y * k, k }, anim);
  }, [size, tween]);

  const zoomAt = useCallback((mx: number, my: number, k2: number) => {
    const v = t.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, k2));
    t.current = { x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k, k };
  }, []);

  const zoomBy = useCallback((f: number) => {
    const { w, h } = size();
    const v = t.current;
    const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f));
    tween({ x: w / 2 - ((w / 2 - v.x) * k) / v.k, y: h / 2 - ((h / 2 - v.y) * k) / v.k, k }, true);
  }, [size, tween]);

  useWatchEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null = null;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      cancelFrame(raf.current);
      if (ev.ctrlKey || ev.metaKey) {
        const r = svg.getBoundingClientRect();
        zoomAt(ev.clientX - r.left, ev.clientY - r.top, t.current.k * Math.exp(-ev.deltaY * 0.01));
      } else {
        const unit = ev.deltaMode === 1 ? 16 : 1;
        t.current = { ...t.current, x: t.current.x - ev.deltaX * unit, y: t.current.y - ev.deltaY * unit };
      }
      apply();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || (ev.target as Element).closest?.("[data-lwg-node],[data-lwg-label]")) return;
      cancelFrame(raf.current);
      drag = { x: ev.clientX, y: ev.clientY, tx: t.current.x, ty: t.current.y, moved: false, id: ev.pointerId };
      svg.setPointerCapture(ev.pointerId);
      svg.setAttribute("data-dragging", "");
    };
    const onMove = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true;
      t.current = { ...t.current, x: drag.tx + dx, y: drag.ty + dy };
      apply();
    };
    const onUp = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved) o.current.onBackgroundClick?.();
      drag = null;
      svg.removeAttribute("data-dragging");
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    return () => {
      cancelFrame(raf.current);
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("pointerdown", onDown);
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointercancel", onUp);
    };
  }, [svgRef, apply, zoomAt]);

  return useMemo(() => ({ fit, centerOn, zoomBy, size, get: () => t.current }), [fit, centerOn, zoomBy, size]);
}
