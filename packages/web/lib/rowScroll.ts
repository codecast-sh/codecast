// How far a list must scroll to bring a row into view, given the row's
// scroll-margin-top: rows in a list with sticky section headings carry the
// heading's height there, so a followed row never lands under its own
// heading. Pure, so the shape is tested without a browser.

type Edges = { top: number; bottom: number };

/** The scroll delta that brings `row` fully into `container`'s view, with
 *  `marginTop` pixels kept clear at the top. 0 when it is already in view. */
export function rowScrollDelta(container: Edges, row: Edges, marginTop = 0): number {
  const top = container.top + marginTop;
  if (row.top < top) return row.top - top;
  if (row.bottom > container.bottom) return Math.min(row.bottom - container.bottom, row.top - top);
  return 0;
}

/** The row's scroll-margin-top in pixels, 0 when unset. */
export function scrollMarginTopOf(el: Element): number {
  const v = parseFloat(getComputedStyle(el).scrollMarginTop);
  return Number.isFinite(v) ? v : 0;
}
