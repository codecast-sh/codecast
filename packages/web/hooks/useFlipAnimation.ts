import { useRef, useCallback, useLayoutEffect, useState } from "react";

const ANIMATION_DURATION_MS = 400;

export function useFlipAnimation() {
  const containerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, DOMRect>>(new Map());
  const [tick, setTick] = useState(0);

  // Capture current positions before React commits DOM changes
  const capturePositions = useCallback(() => {
    if (!containerRef.current) return;
    const map = new Map<string, DOMRect>();
    const children = containerRef.current.querySelectorAll("[data-flip-key]");
    children.forEach((el) => {
      const key = el.getAttribute("data-flip-key");
      if (key) {
        map.set(key, el.getBoundingClientRect());
      }
    });
    positionsRef.current = map;
  }, []);

  // After DOM update, compute delta and animate
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const oldPositions = positionsRef.current;
    if (oldPositions.size === 0) return;

    const children = containerRef.current.querySelectorAll("[data-flip-key]");
    children.forEach((el) => {
      const key = el.getAttribute("data-flip-key");
      if (!key) return;

      const oldRect = oldPositions.get(key);
      if (!oldRect) return;

      const newRect = el.getBoundingClientRect();
      const deltaY = oldRect.top - newRect.top;
      const deltaX = oldRect.left - newRect.left;

      if (Math.abs(deltaY) < 1 && Math.abs(deltaX) < 1) return;

      const htmlEl = el as HTMLElement;
      htmlEl.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      htmlEl.style.transition = "none";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          htmlEl.style.transition = `transform ${ANIMATION_DURATION_MS}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
          htmlEl.style.transform = "";
        });
      });
    });

    positionsRef.current = new Map();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Call this right before the reorder happens
  const beforeReorder = useCallback(() => {
    capturePositions();
    // Trigger the layout effect after React re-renders with new order
    setTick((t) => t + 1);
  }, [capturePositions]);

  return { containerRef, beforeReorder };
}
