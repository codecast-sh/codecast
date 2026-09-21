import { useRef, useCallback, useLayoutEffect, useState } from "react";

const ANIMATION_DURATION_MS = 400;

/** `scale` also animates a change of size (a panel that moves AND resizes);
 *  the default moves only, which is right for rows of a fixed size. */
export function useFlipAnimation({ scale = false, durationMs = ANIMATION_DURATION_MS }: { scale?: boolean; durationMs?: number } = {}) {
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
    // A hidden tab pauses requestAnimationFrame, which would leave the inverted
    // transform on screen until the tab is shown again.
    if (document.hidden || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      positionsRef.current = new Map();
      return;
    }

    const children = containerRef.current.querySelectorAll("[data-flip-key]");
    children.forEach((el) => {
      const key = el.getAttribute("data-flip-key");
      if (!key) return;

      const oldRect = oldPositions.get(key);
      if (!oldRect) return;

      const newRect = el.getBoundingClientRect();
      const deltaY = oldRect.top - newRect.top;
      const deltaX = oldRect.left - newRect.left;

      // Scaling reads as one object changing size only between similar shapes.
      // Past ~2.5x on either axis (a panel folding to its title bar) it smears
      // the content, so the element just slides to its new place.
      const similar = (a: number, b: number) => a > 0 && b > 0 && Math.max(a / b, b / a) <= 2.5;
      const resized = scale && similar(oldRect.width, newRect.width) && similar(oldRect.height, newRect.height)
        && (Math.abs(oldRect.width - newRect.width) >= 1 || Math.abs(oldRect.height - newRect.height) >= 1);

      if (Math.abs(deltaY) < 1 && Math.abs(deltaX) < 1 && !resized) return;

      const htmlEl = el as HTMLElement;
      htmlEl.style.transformOrigin = resized ? "top left" : "";
      htmlEl.style.transform = `translate(${deltaX}px, ${deltaY}px)`
        + (resized ? ` scale(${oldRect.width / newRect.width}, ${oldRect.height / newRect.height})` : "");
      htmlEl.style.transition = "none";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          htmlEl.style.transition = `transform ${durationMs}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
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
