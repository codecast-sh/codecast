// Which edges of a sideways scroller have more content past them, for the
// fades that say so (the Priorities chips, both apps): a left fade once
// scrolled from the start, a right fade while more lies to the right.
export type ScrollEdges = { left: boolean; right: boolean };

export function scrollEdges(scrollLeft: number, viewportWidth: number, contentWidth: number): ScrollEdges {
  return { left: scrollLeft > 1, right: scrollLeft + viewportWidth < contentWidth - 1 };
}

export const sameEdges = (a: ScrollEdges, b: ScrollEdges) => a.left === b.left && a.right === b.right;
