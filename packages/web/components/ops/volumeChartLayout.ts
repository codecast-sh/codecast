// The volume chart's layout: its measured width, and where deploy marks sit
// and merge so their labels never collide or run off the edge.
import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";

/** The measured width of an element, kept current as it resizes. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useWatchEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A merged deploy label is this wide at most; marks nearer than that merge. */
export const MARK_PX = 104;

/** A label that would run past the right edge hangs to the left of its line instead. */
export const endAnchored = (x: number, width: number) => (width > 0 ? x * width + MARK_PX > width : x > 0.85);

/**
 * Marks clustered left to right, with a left-hanging label (near the right
 * edge) folded into the one before it when the two labels would meet: they
 * grow toward each other, so they need twice the room.
 */
export function mergeFacing<M extends { at: number }>(groups: { x: number; marks: M[] }[], width: number): { x: number; marks: M[] }[] {
  const out: { x: number; marks: M[] }[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    if (prev && endAnchored(g.x, width) && !endAnchored(prev.x, width) && (g.x - prev.x) * width < 2 * MARK_PX) {
      out[out.length - 1] = { x: g.x, marks: [...prev.marks, ...g.marks] };
    } else out.push(g);
  }
  return out;
}
