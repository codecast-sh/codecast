// One react-resizable-panels Group that can fold a side away and keeps the
// person's split (essence spec §5): shared by the Org screen's canvas and
// panel and by a scope's conversation and panel.
//
// The Group reads its layout once, at mount; every later change (a fold, an
// unfold, a split that arrived from another window or a reset) is driven
// through its handle. Only a drag of this Group's own separator is persisted
// (useDragGatedLayoutPersist, scoped to the Group's element), so a clamp
// caused by another seam narrowing the page is never stored, and the re-apply
// on a width change can always put the person's split back. A side is
// collapsible only while it is folded, so a drag stops at the minimums; the
// Group takes a panel's new constraints on its own next render, so a move
// waits one microtask for it. A Group with no width yet (a hidden tab)
// ignores setLayout, so it waits for one.
import { useRef } from "react";
import { useGroupRef, type Layout } from "react-resizable-panels";
import { useDragGatedLayoutPersist } from "./useDragGatedLayoutPersist";
import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";

const near = (a: Layout, b: Layout) => Object.keys(b).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.1);
const signature = (l: Layout) => Object.keys(l).sort().map((k) => `${k}:${l[k]}`).join("|");

export function useFoldingSplit({ target, folded, onPersist, onReset }: {
  /** The layout to hold: the person's split, or a side folded to 0. */
  target: Layout;
  /** A side is folded away: nothing is dragged, persisted or reset. */
  folded: boolean;
  /** A drag of this Group's separator ended with both sides showing. */
  onPersist: (layout: Layout) => void;
  /** The separator was double-clicked with both sides showing. */
  onReset: () => void;
}) {
  const groupRef = useGroupRef();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const defaultLayout = useRef(target).current;
  const targetRef = useRef(target);
  targetRef.current = target;
  const foldedRef = useRef(folded);
  foldedRef.current = folded;

  const apply = () => {
    const group = groupRef.current;
    const el = elementRef.current;
    if (!group || !el || el.offsetWidth === 0 || near(group.getLayout(), targetRef.current)) return;
    group.setLayout(targetRef.current);
  };
  useWatchEffect(() => queueMicrotask(apply), [signature(target)]);

  // The width changed (the first measure, a rail folding, a window resize):
  // the library keeps the percentages it last had, so the person's split is
  // put back. The library learns the width from its own observer, which may
  // run after this one, so the move waits a task.
  useMountEffect(() => {
    const el = elementRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === width) return;
      width = el.offsetWidth;
      setTimeout(apply, 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const onLayoutChange = useDragGatedLayoutPersist((next) => { if (!foldedRef.current) onPersist(next); }, elementRef);
  // The library's double-click puts the separator back at the panels' default
  // after the pointer is up, outside the drag gate, so the reset is written here.
  const onSeparatorDoubleClick = () => { if (!foldedRef.current) onReset(); };

  return { groupRef, elementRef, defaultLayout, onLayoutChange, onSeparatorDoubleClick };
}
