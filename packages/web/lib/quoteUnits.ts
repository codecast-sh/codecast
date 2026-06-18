// The set of "quote units" inside a rendered assistant message body — the
// smallest pieces a reader can quote on their own. Normally each unit is a
// top-level block (paragraph, heading, code fence, table, blockquote, the
// ★ Insight card…), i.e. a direct child of the `.cc-content` column. The one
// exception: a bulleted/numbered LIST is expanded into one unit per <li>, so a
// reader can quote a single bullet/number instead of the whole list.
//
// `blockIndex` (PendingComment) is just a flat index into this ordering, so BOTH
// quote entry points — the hover handle in MessageReview and the text-selection
// toolbar — must resolve indices against this single source of truth, or their
// indices would disagree and a comment would anchor to the wrong line.

// Ordered quote units for a content column. A top-level <ul>/<ol> contributes its
// direct <li> children; every other top-level block contributes itself.
export function getQuoteUnits(content: HTMLElement | null): HTMLElement[] {
  if (!content) return [];
  const units: HTMLElement[] = [];
  for (const child of Array.from(content.children) as HTMLElement[]) {
    if (child.tagName === "OL" || child.tagName === "UL") {
      const items = (Array.from(child.children) as HTMLElement[]).filter((li) => li.tagName === "LI");
      if (items.length) {
        units.push(...items);
        continue;
      }
    }
    units.push(child);
  }
  return units;
}

// The quote unit containing `target` (a hovered node or a selection anchor), and
// its index — found by walking up to the first ancestor that is itself a unit.
// Null when the target is outside the content column.
export function quoteUnitAt(
  content: HTMLElement | null,
  target: HTMLElement | null,
): { index: number; el: HTMLElement } | null {
  if (!content || !target) return null;
  const units = getQuoteUnits(content);
  let el: HTMLElement | null = target;
  while (el && el !== content) {
    const idx = units.indexOf(el);
    if (idx >= 0) return { index: idx, el };
    el = el.parentElement;
  }
  return null;
}

// Vertical offset (px) of a unit's top edge relative to the content column's top,
// in LAYOUT space — summed up the offsetParent chain rather than read from
// getBoundingClientRect. This matters under browser zoom (Cmd +/-): bounding rects
// report screen coordinates already multiplied by the zoom factor, but the inline
// `top` we set is in the element's own unscaled layout space (the browser scales it
// again to paint), so a rect value would apply the zoom twice and strand the handle.
// offsetTop lives in the same layout space as that `top`, so it stays aligned at any
// zoom. Summing the chain also keeps it correct for a nested <li> whose offsetParent
// is some positioned wrapper rather than `.cc-content` itself.
export function unitTop(content: HTMLElement, el: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== content) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}
