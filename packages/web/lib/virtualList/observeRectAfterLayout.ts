import type { Virtualizer } from "@tanstack/react-virtual";

type Rect = { width: number; height: number };

/**
 * The virtualizer's observeElementRect option, without the synchronous read.
 *
 * virtual-core's default reads the scroller's offsetWidth/offsetHeight while
 * the virtualizer mounts, inside React's commit, right after that commit's DOM
 * writes: a forced layout in React's own task on every first paint of a
 * conversation (ct-101552, the inbox's 1,208 ms first-paint freeze). Here the
 * first rect is the window's size, which the browser knows without laying the
 * page out and which is never shorter than the scroller, so the first commit
 * draws every row the viewport can show. The scroller's real size arrives in
 * the ResizeObserver's initial callback, after the frame's own layout and
 * before it paints; the bottom hold re-aims the opening scroll on that change.
 */
export function observeRectAfterLayout(instance: Virtualizer<HTMLElement, Element>, cb: (rect: Rect) => void) {
  const element = instance.scrollElement;
  const win = instance.targetWindow;
  if (!element || !win) return;
  const read = () => cb({ width: element.offsetWidth, height: element.offsetHeight });
  if (!win.ResizeObserver) {
    read();
    return () => {};
  }
  cb({ width: win.innerWidth, height: win.innerHeight });
  const observer = new win.ResizeObserver((entries) => {
    const box = entries[0]?.borderBoxSize?.[0];
    if (box) cb({ width: Math.round(box.inlineSize), height: Math.round(box.blockSize) });
    else read();
  });
  observer.observe(element, { box: "border-box" });
  return () => observer.disconnect();
}
