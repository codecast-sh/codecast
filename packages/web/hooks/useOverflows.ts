import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";

/** Whether the element's content is taller than `maxHeight`, kept current as
 *  the content resizes. scrollHeight counts content a max-height clips, so the
 *  answer holds while the element is clamped. Children are observed too: a
 *  clamped element keeps its own size while its content grows.
 *
 *  The first answer is taken in a layout effect, before the browser paints:
 *  callers clamp on it, and a mount that painted unclamped and clamped a frame
 *  later changed the row's height under the conversation virtualizer, which
 *  moved scrollTop to match and visibly jumped the feed while scrolling up. */
export function useOverflows(ref: RefObject<HTMLElement | null>, maxHeight: number, deps: DependencyList = []): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > maxHeight);
    check();
    // A window with no layout (a test's jsdom) has nothing to watch: the first answer stands.
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(check);
    obs.observe(el);
    for (const child of el.children) obs.observe(child);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxHeight, ...deps]);
  return overflows;
}
