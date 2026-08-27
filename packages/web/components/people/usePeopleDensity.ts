import { useState, type RefObject } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { densityFor, type PeopleDensity } from "./peopleDensity";

/**
 * Which shape the panel takes, measured from the panel's own box.
 *
 * One ResizeObserver on the root, and a state that only changes when the
 * DENSITY changes — a window being dragged by a corner fires this every frame,
 * and the panel must not re-render for a pixel that changes nothing it draws.
 * The first paint uses the window's inner size so the right shape is there
 * before the observer's first callback: a strip window must never flash the
 * full header for one frame.
 */
export function usePeopleDensity(ref: RefObject<HTMLElement | null>): PeopleDensity {
  const [density, setDensity] = useState<PeopleDensity>(() =>
    typeof window === "undefined" ? "full" : densityFor(window.innerWidth, window.innerHeight),
  );
  useMountEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setDensity((prev) => {
        const next = densityFor(box.width, box.height);
        return next === prev ? prev : next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
  return density;
}
