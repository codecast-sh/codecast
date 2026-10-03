// Bringing an element into view by scrolling ONE surface: the nearest
// scrolling ancestor, never the page around it.
//
// Element.scrollIntoView scrolls every ancestor that can scroll, so a line
// brought into view inside a list that sits in a page that also scrolls moves
// the page too: the call page opened at a moment (`?t=`) scrolled its stage
// cell 24px and sliced the title in half. Here only the surface the element
// scrolls with moves; with none (a page that scrolls as a whole), the
// document does.

import { cssZoomOf } from "./cssZoom";
import { prefersReducedMotion } from "./reducedMotion";

/** The nearest scrolling ancestor: the surface an element scrolls with. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

/** Where `el` should land in `box`'s view, as the scrollTop that puts it
 *  there, or null when it is already where it should be. Pure geometry, in
 *  layout px: `top` is the element's offset from the view's top edge.
 *  `center` centres it (or puts its top at the top when it is taller than the
 *  view); `nearest` moves it the least distance that shows it whole. */
export function scrollTopFor(
  view: { scrollTop: number; height: number },
  el: { top: number; height: number },
  block: "center" | "nearest",
): number | null {
  if (block === "center") {
    const delta = el.height >= view.height ? el.top : el.top - (view.height - el.height) / 2;
    return Math.abs(delta) < 1 ? null : view.scrollTop + delta;
  }
  if (el.top < 0) return view.scrollTop + el.top;
  if (el.top + el.height > view.height) return view.scrollTop + (el.height > view.height ? el.top : el.top + el.height - view.height);
  return null;
}

/** Scroll the surface `el` scrolls with so it is in view: centred, or the
 *  least move (`nearest`). `smooth` animates, unless the person asked their
 *  system for less motion. */
export function scrollIntoContainer(el: HTMLElement, opts: { block?: "center" | "nearest"; smooth?: boolean } = {}): void {
  // The root scrolling as an "ancestor" is the document: its rect moves with
  // its own scroll, so it is measured as the viewport instead.
  const parent = scrollParentOf(el);
  const box = parent && parent !== document.documentElement && parent !== document.body ? parent : null;
  const doc = document.scrollingElement as HTMLElement | null;
  const surface = box ?? doc;
  if (!surface) return;
  const zoom = cssZoomOf(el);
  const rect = el.getBoundingClientRect();
  const viewTop = box ? box.getBoundingClientRect().top + box.clientTop * zoom : 0;
  const height = box ? box.clientHeight : window.innerHeight / zoom;
  const top = scrollTopFor(
    { scrollTop: surface.scrollTop, height },
    { top: (rect.top - viewTop) / zoom, height: rect.height / zoom },
    opts.block ?? "nearest",
  );
  if (top === null) return;
  surface.scrollTo({ top: Math.max(0, top), behavior: opts.smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}
