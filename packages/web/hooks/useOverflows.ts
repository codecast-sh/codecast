import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";

// Every hook that measures in one commit measures in one pass: a microtask
// after the commit's layout effects, still before the browser paints. The
// reads run back to back with no writes between them, so the page is laid out
// once for the whole batch; a read inside each hook's own layout effect laid
// it out once per mounted row (a conversation's first paint mounts dozens).
const pending = new Map<HTMLElement, () => void>();
let flushQueued = false;
function measureBeforePaint(el: HTMLElement, check: () => void) {
  pending.set(el, check);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const checks = [...pending.values()];
    pending.clear();
    for (const check of checks) check();
  });
}

/** Whether the element's content is taller than `maxHeight`, kept current as
 *  the content resizes. scrollHeight counts content a max-height clips, so the
 *  answer holds while the element is clamped. Children are observed too: a
 *  clamped element keeps its own size while its content grows.
 *
 *  The first answer is taken before the browser paints: callers clamp on it,
 *  and a mount that painted unclamped and clamped a frame later changed the
 *  row's height under the conversation virtualizer, which moved scrollTop to
 *  match and visibly jumped the feed while scrolling up. */
export function useOverflows(ref: RefObject<HTMLElement | null>, maxHeight: number, deps: DependencyList = []): boolean {
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const check = () => { if (live) setOverflows(el.scrollHeight > maxHeight); };
    measureBeforePaint(el, check);
    // A window with no layout (a test's jsdom) has nothing to watch: the first answer stands.
    if (typeof ResizeObserver === "undefined") return () => { live = false; };
    const obs = new ResizeObserver(check);
    obs.observe(el);
    for (const child of el.children) obs.observe(child);
    return () => { live = false; pending.delete(el); obs.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxHeight, ...deps]);
  return overflows;
}
