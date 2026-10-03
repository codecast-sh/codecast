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

/** How a target lands: `center`, `nearest`, or `reading`, a third of the
 *  way down, the way a reader's eye sits on a page (and a lyric on a
 *  screen): what led up to it stays in view above, what comes next below. */
export type ScrollBlock = "center" | "nearest" | "reading";

/** Where `el` should land in `box`'s view, as the scrollTop that puts it
 *  there, or null when it is already where it should be. Pure geometry, in
 *  layout px: `top` is the element's offset from the view's top edge.
 *  `center` centres it (or puts its top at the top when it is taller than the
 *  view); `reading` puts its top a third of the way down (or at the top when
 *  it would not fit below); `nearest` moves it the least distance that shows
 *  it whole. */
export function scrollTopFor(
  view: { scrollTop: number; height: number },
  el: { top: number; height: number },
  block: ScrollBlock,
): number | null {
  if (block === "center") {
    const delta = el.height >= view.height ? el.top : el.top - (view.height - el.height) / 2;
    return Math.abs(delta) < 1 ? null : view.scrollTop + delta;
  }
  if (block === "reading") {
    const third = Math.round(view.height / 3);
    const delta = el.height > view.height - third ? el.top : el.top - third;
    return Math.abs(delta) < 1 ? null : view.scrollTop + delta;
  }
  if (el.top < 0) return view.scrollTop + el.top;
  if (el.top + el.height > view.height) return view.scrollTop + (el.height > view.height ? el.top : el.top + el.height - view.height);
  return null;
}

/** A scrollTop moved so the view's top edge falls between two rows rather
 *  than through one: a row sliced in half under a header reads as broken.
 *  Everything is in content px (offsets from the scroller's content top).
 *  The row the edge cuts is the smallest one it passes through (a line
 *  inside a turn before the turn), and the edge moves up to that row's top,
 *  showing it whole, unless that would push `el` out of the bottom; then down
 *  past it, unless that would hide `el`'s top. Otherwise `top` stands. */
export function snapToRowEdge(
  top: number,
  rows: ReadonlyArray<{ top: number; height: number }>,
  el: { top: number; height: number },
  viewHeight: number,
): number {
  let cut: { top: number; height: number } | null = null;
  for (const r of rows) {
    if (r.top < top - 0.5 && r.top + r.height > top + 0.5 && (!cut || r.height < cut.height)) cut = r;
  }
  if (!cut) return top;
  if (el.top + el.height <= cut.top + viewHeight) return cut.top;
  const below = cut.top + cut.height;
  return below <= el.top ? below : top;
}

/** Scroll the surface `el` scrolls with so it is in view: centred, a third
 *  down (`reading`), or the least move (`nearest`). `snap` names the rows the
 *  view's top edge should fall between (snapToRowEdge). `smooth` animates,
 *  unless the person asked their system for less motion. */
export function scrollIntoContainer(el: HTMLElement, opts: { block?: ScrollBlock; smooth?: boolean; snap?: string } = {}): void {
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
  let to = Math.max(0, Math.min(top, surface.scrollHeight - height));
  if (opts.snap) {
    // In content px: where each row and the element sit under the scroller.
    const at = (r: DOMRect) => ({ top: (r.top - viewTop) / zoom + surface.scrollTop, height: r.height / zoom });
    const rows = Array.from((box ?? document).querySelectorAll<HTMLElement>(opts.snap), (n) => at(n.getBoundingClientRect()));
    to = snapToRowEdge(to, rows, at(rect), height);
  }
  if (Math.abs(to - surface.scrollTop) < 1) return;
  surface.scrollTo({ top: Math.max(0, to), behavior: opts.smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}
