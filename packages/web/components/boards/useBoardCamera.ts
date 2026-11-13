// The board's camera: pan and zoom without re-rendering the board. A gesture
// writes the transform straight onto the world layer and the grid; React
// hears about it only through a throttled viewport (for culling and the
// overlays), so a pan stays at 60fps with hundreds of elements.
import { useCallback, useMemo, useRef, useState } from "react";
import type { Box, Pt } from "@codecast/shared/artifacts/board";
import { useMountEffect } from "../../hooks/useMountEffect";

/** screen = world * z + (x, y) */
export type Cam = { x: number; y: number; z: number };

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;
const GRID = 24;
/** The smallest zoom an opening frame uses; stickies still read at it. */
const READABLE_Z = 0.4;
const clampZ = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

function storageKey(docId: string) {
  return `board-cam:${docId}`;
}

/** The camera this tab last left the board at, with the pane size it was framed for. */
function readSaved(docId: string): (Cam & { w?: number; h?: number }) | null {
  try {
    const raw = sessionStorage.getItem(storageKey(docId));
    const c = raw ? JSON.parse(raw) : null;
    return c && [c.x, c.y, c.z].every((n: unknown) => typeof n === "number" && Number.isFinite(n)) ? c : null;
  } catch {
    return null;
  }
}

/** The camera that frames `box` inside a w x h viewport, with margin, never zooming past 100%. */
export function fitCam(box: Box, w: number, h: number, margin = 80, maxZ = 1): Cam {
  const z = clampZ(Math.min(maxZ, (w - margin * 2) / Math.max(box.w, 1), (h - margin * 2) / Math.max(box.h, 1)));
  return { z, x: w / 2 - (box.x + box.w / 2) * z, y: h / 2 - (box.y + box.h / 2) * z };
}

/** Room around fitted content: 80px on a wide canvas, less in a narrow pane so the content keeps its size. */
export function fitMargin(w: number, h: number): number {
  return Math.round(Math.max(24, Math.min(80, Math.min(w, h) * 0.06)));
}

/** Zoom by `factor` keeping the world point under `at` (screen px) still. */
export function zoomAround(cam: Cam, factor: number, at: Pt): Cam {
  const z = clampZ(cam.z * factor);
  const k = z / cam.z;
  return { z, x: at.x - (at.x - cam.x) * k, y: at.y - (at.y - cam.y) * k };
}

export type Viewport = { cam: Cam; w: number; h: number; world: Box };

export function useBoardCamera(docId: string) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const saved = useRef(readSaved(docId)).current;
  const cam = useRef<Cam>(saved ? { x: saved.x, y: saved.y, z: saved.z } : { x: 0, y: 0, z: 1 });
  const hadSaved = useRef(saved !== null);
  /** The pane size the saved camera was framed for: a different pane frames the content again. */
  const savedFor = useRef(saved && saved.w && saved.h ? { w: saved.w, h: saved.h } : null);
  const [viewport, setViewport] = useState<Viewport>(() => ({ cam: cam.current, w: 0, h: 0, world: { x: 0, y: 0, w: 0, h: 0 } }));
  const listeners = useRef(new Set<(c: Cam) => void>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPublish = useRef(0);

  // The canvas's place on the page, read once per publish (resize, pan settle), never per pointer move.
  const rect = useRef<{ left: number; top: number }>({ left: 0, top: 0 });
  const publish = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    rect.current = { left: r.left, top: r.top };
    const { x, y, z } = cam.current;
    const w = root.clientWidth, h = root.clientHeight;
    lastPublish.current = performance.now();
    setViewport({ cam: { x, y, z }, w, h, world: { x: -x / z, y: -y / z, w: w / z, h: h / z } });
    try { sessionStorage.setItem(storageKey(docId), JSON.stringify({ ...cam.current, w, h })); } catch { /* private mode */ }
  }, [docId]);

  const paint = useCallback(() => {
    const { x, y, z } = cam.current;
    const world = worldRef.current, root = rootRef.current;
    if (world) world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
    if (root) {
      root.style.setProperty("--z", String(z));
      // Far out, stickies show their titles only, large enough to read (board.css).
      const far = z < 0.32;
      if (far !== (root.dataset.lod === "far")) { if (far) root.dataset.lod = "far"; else delete root.dataset.lod; }
      // Dots thin out as you zoom out, so the grid never turns into noise.
      const step = GRID * z * (z < 0.35 ? 4 : z < 0.7 ? 2 : 1);
      root.style.setProperty("--grid-size", `${step}px`);
      root.style.setProperty("--grid-x", `${x}px`);
      root.style.setProperty("--grid-y", `${y}px`);
    }
    for (const fn of listeners.current) fn(cam.current);
    // React hears at most every 120ms during a gesture, and once at rest.
    if (timer.current) clearTimeout(timer.current);
    if (performance.now() - lastPublish.current > 120) publish();
    else timer.current = setTimeout(publish, 120);
  }, [publish]);

  const set = useCallback((next: Cam) => {
    cam.current = { x: next.x, y: next.y, z: clampZ(next.z) };
    paint();
  }, [paint]);

  const animTo = useRef<number | null>(null);
  /** Glide to a camera (fit, zoom buttons). Instant when reduced motion is on. */
  const glide = useCallback((to: Cam) => {
    if (animTo.current) cancelAnimationFrame(animTo.current);
    // No animation frames run in a hidden tab, and reduced motion asks for none.
    if (typeof window !== "undefined" && (document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)) return set(to);
    const from = { ...cam.current };
    const t0 = performance.now();
    const dur = 240;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      set({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e });
      animTo.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    animTo.current = requestAnimationFrame(step);
  }, [set]);

  const stopGlide = useCallback(() => {
    if (animTo.current) cancelAnimationFrame(animTo.current);
    animTo.current = null;
  }, []);

  const toWorld = useCallback((p: Pt): Pt => {
    const { x, y, z } = cam.current;
    return { x: (p.x - x) / z, y: (p.y - y) / z };
  }, []);

  const toScreen = useCallback((p: Pt): Pt => {
    const { x, y, z } = cam.current;
    return { x: p.x * z + x, y: p.y * z + y };
  }, []);

  /** Client (event) coordinates -> world. */
  const clientToWorld = useCallback((clientX: number, clientY: number): Pt => {
    return toWorld({ x: clientX - rect.current.left, y: clientY - rect.current.top });
  }, [toWorld]);

  const zoomBy = useCallback((factor: number, at?: Pt) => {
    const root = rootRef.current;
    const center = at ?? { x: (root?.clientWidth ?? 0) / 2, y: (root?.clientHeight ?? 0) / 2 };
    glide(zoomAround(cam.current, factor, center));
  }, [glide]);

  const fit = useCallback((box: Box | null, opts?: { instant?: boolean; maxZ?: number; minReadable?: boolean; insets?: { top?: number; right?: number; bottom?: number; left?: number } }) => {
    const root = rootRef.current;
    if (!root) return;
    // The board's own chrome (toolbar, zoom bar, overview) covers its edges: frame the content in what is left.
    const ins = { top: 0, right: 0, bottom: 0, left: 0, ...opts?.insets };
    const W = Math.max(120, root.clientWidth - ins.left - ins.right), H = Math.max(120, root.clientHeight - ins.top - ins.bottom);
    let target = box ? fitCam(box, W, H, fitMargin(W, H), opts?.maxZ ?? 1) : { x: W / 2, y: H / 2, z: 1 };
    target = { ...target, x: target.x + ins.left, y: target.y + ins.top };
    // A narrow pane (a phone, a split) would fit a big board at an unreadable size: open at half size on its top-left instead.
    if (box && opts?.minReadable && W < 700 && target.z < READABLE_Z) {
      const m = fitMargin(W, H);
      target = { z: READABLE_Z, x: ins.left + m - box.x * READABLE_Z, y: ins.top + m - box.y * READABLE_Z };
    }
    if (opts?.instant) set(target);
    else glide(target);
  }, [glide, set]);

  // Wheel: two-finger scroll pans, pinch (ctrl+wheel) and cmd+wheel zoom.
  // Bound natively with passive:false so the page never scrolls or zooms instead.
  useMountEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("[data-board-scroll]")) return;
      e.preventDefault();
      // Direct input wins over a glide in progress (Fit, zoom buttons).
      if (animTo.current) { cancelAnimationFrame(animTo.current); animTo.current = null; }
      const r = root.getBoundingClientRect();
      const at = { x: e.clientX - r.left, y: e.clientY - r.top };
      const scale = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        set(zoomAround(cam.current, Math.exp(-e.deltaY * scale * 0.0075), at));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        set({ ...cam.current, x: cam.current.x - dx * scale, y: cam.current.y - dy * scale });
      }
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => publish());
    ro.observe(root);
    paint();
    return () => {
      root.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (timer.current) clearTimeout(timer.current);
      if (animTo.current) cancelAnimationFrame(animTo.current);
    };
  });

  /** Subscribe to every camera frame (cursor overlays that must track a pan exactly). */
  const onCamera = useCallback((fn: (c: Cam) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  return useMemo(
    () => ({ rootRef, worldRef, cam, viewport, hadSaved, savedFor, set, glide, stopGlide, toWorld, toScreen, clientToWorld, zoomBy, fit, onCamera }),
    [viewport, set, glide, stopGlide, toWorld, toScreen, clientToWorld, zoomBy, fit, onCamera],
  );
}

export type BoardCamera = ReturnType<typeof useBoardCamera>;
