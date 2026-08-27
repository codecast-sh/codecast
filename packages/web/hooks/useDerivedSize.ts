import { useState, type RefObject } from "react";
import { useMountEffect } from "./useMountEffect";

/**
 * A value DERIVED from an element's size, re-rendering only when the derived
 * value changes.
 *
 * A raw ResizeObserver hook re-renders its subscriber on every pixel of a
 * drag. Most callers do not want the pixels — they want a breakpoint, a
 * column count, a layout mode — so the derive function runs inside the
 * observer and the state only moves when its answer does. `initial` supplies
 * the first-paint answer (from the window, a guess, a constant) so the right
 * shape is there before the observer's first callback.
 */
export function useDerivedSize<T>(
  ref: RefObject<HTMLElement | null>,
  derive: (width: number, height: number) => T,
  initial: () => T,
): T {
  const [value, setValue] = useState<T>(initial);
  useMountEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      setValue((prev) => {
        const next = derive(w, h);
        return next === prev ? prev : next;
      });
    // Measure NOW: the observer's first callback is async, and initial() was
    // a guess about an element that exists by this point.
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
  return value;
}
