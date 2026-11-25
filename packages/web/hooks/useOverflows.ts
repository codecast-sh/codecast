import { useLayoutEffect, useState, type DependencyList, type RefObject } from "react";
import { flushSync } from "react-dom";
import { measureInFrame } from "../lib/frameMeasure";

// One observer for every hook, and one batch for every answer. Every element
// in a batch is read before any answer is set, so the reads find the layout
// already computed and none of them forces another. A read per hook in its
// own effect laid the page out once per mounted row, against a page the
// transcript had just rewritten.
//
// The batch is read at the start of the next frame (measureInFrame), beside
// every other read queued there, and applied with flushSync, so the clamp is
// in the DOM before the browser paints. Read in a microtask after the commit,
// it laid out the page the commit had just written, inside the commit's own
// task (ct-101461). A state set from the observer callback renders on a later
// task, after paint: a long session message painted at full height, the
// virtualizer measured it, then it clamped, and near the tail the 900px swing
// remounted the rows above in a loop that shook the conversation several
// times a second.
type Watch = { read: () => boolean; set: (v: boolean) => void };
const due = new Set<Watch>();

function answerBeforePaint(w: Watch) {
  if (due.size === 0) {
    measureInFrame(() => {
      const answers = [...due].map((d) => [d, d.read()] as const);
      due.clear();
      return answers;
    }, (answers) => {
      flushSync(() => { for (const [d, v] of answers) d.set(v); });
    });
  }
  due.add(w);
}
const watchesByTarget = new Map<Element, Set<Watch>>();
let shared: ResizeObserver | null = null;

function observer(): ResizeObserver {
  shared ??= new ResizeObserver((entries) => {
    for (const e of entries) for (const w of watchesByTarget.get(e.target) ?? []) answerBeforePaint(w);
  });
  return shared;
}

function watch(w: Watch, targets: Element[]): () => void {
  const ro = observer();
  for (const t of targets) {
    let set = watchesByTarget.get(t);
    if (!set) { set = new Set(); watchesByTarget.set(t, set); ro.observe(t); }
    set.add(w);
  }
  answerBeforePaint(w);
  return () => {
    due.delete(w);
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
    // A window with no layout (a test's jsdom) has no observer: one answer stands.
    if (typeof ResizeObserver === "undefined") { setFlag(read(el)); return; }
    return watch({ read: () => read(el), set: setFlag }, [el, ...el.children]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return flag;
}

/** Whether the element's content is taller than `maxHeight`, kept current as
 *  the content resizes. scrollHeight counts content a max-height clips, so the
 *  answer holds while the element is clamped. Children are observed too: a
 *  clamped element keeps its own size while its content grows.
 *
 *  The first answer is applied before the browser paints: callers clamp on it,
 *  and a mount that painted unclamped and clamped a frame later changed the
 *  row's height under the conversation virtualizer, which moved scrollTop to
 *  match and visibly jumped the feed while scrolling up. */
export function useOverflows(ref: RefObject<HTMLElement | null>, maxHeight: number, deps: DependencyList = []): boolean {
  return useLayoutFlag(ref, (el) => el.scrollHeight > maxHeight, [maxHeight, ...deps]);
}
