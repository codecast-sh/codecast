import { useCallback, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

/** The width of the element `measureRef` sits on: null until it is laid out
 *  (a root with no width is not laid out yet, or never will be, as in a test
 *  DOM), live through a ResizeObserver after. A callback ref, so a page that
 *  paints a loading state first is still measured once its root mounts. The
 *  measure half of usePanelLayout, for a page that picks its own layout. */
export function useMeasuredWidth(): { width: number | null; measureRef: (el: HTMLElement | null) => void } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useWatchEffect(() => {
    if (!el) return;
    const apply = (w: number) => setWidth(w > 0 ? w : null);
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { const box = entries[0]?.contentRect; if (box) apply(box.width); });
    ro.observe(el);
    // A background tab's observer can lag a layout change by seconds; a
    // window resize and the next frame after mount re-measure directly.
    const remeasure = () => apply(el.getBoundingClientRect().width);
    const frame = requestAnimationFrame(remeasure);
    window.addEventListener("resize", remeasure);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", remeasure); };
  }, [el]);
  const measureRef = useCallback((node: HTMLElement | null) => setEl(node), []);
  return { width, measureRef };
}
