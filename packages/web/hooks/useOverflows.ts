import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";

// One observer for every hook. Its callback runs after the browser lays the
// frame out and before it paints, so the first answer for a new element still
// lands before paint, and every element in the batch is read before any
// answer is set: the reads find the layout already computed and none of them
// forces another. A read per hook in its own effect laid the page out once per
// mounted row, against a page the transcript had just rewritten.
type Watch = { el: HTMLElement; check: () => void };
const watchesByTarget = new Map<Element, Set<Watch>>();
let shared: ResizeObserver | null = null;

function observer(): ResizeObserver {
  shared ??= new ResizeObserver((entries) => {
    const due = new Set<Watch>();
    for (const e of entries) for (const w of watchesByTarget.get(e.target) ?? []) due.add(w);
    for (const w of due) w.check();
  });
  return shared;
}

function watch(w: Watch, targets: Element[]): () => void {
  const ro = observer();
  let observedFresh = false;
  for (const t of targets) {
    let set = watchesByTarget.get(t);
    if (!set) { set = new Set(); watchesByTarget.set(t, set); ro.observe(t); observedFresh = true; }
    set.add(w);
  }
  // Every target already watched by another hook: no first callback is coming.
  if (!observedFresh) queueMicrotask(w.check);
  return () => {
    for (const t of targets) {
      const set = watchesByTarget.get(t);
      if (!set) continue;
      set.delete(w);
      if (set.size === 0) { watchesByTarget.delete(t); ro.unobserve(t); }
    }
  };
}

/** A yes/no read off an element's layout (`read`), kept current as it or its
 *  children resize, and first answered before the browser paints. While
 *  `enabled` is false nothing is read and the last answer stands. */
export function useLayoutFlag(
  ref: RefObject<HTMLElement | null>,
  read: (el: HTMLElement) => boolean,
  deps: DependencyList,
  enabled = true,
): boolean {
  const [flag, setFlag] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const check = () => setFlag(read(el));
    // A window with no layout (a test's jsdom) has no observer: one answer stands.
    if (typeof ResizeObserver === "undefined") { check(); return; }
    return watch({ el, check }, [el, ...el.children]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return flag;
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
  return useLayoutFlag(ref, (el) => el.scrollHeight > maxHeight, [maxHeight, ...deps]);
}
