import type { VirtualItem } from "@tanstack/react-virtual";

export interface ResizeAdjustInput {
  /** The resized row's start offset in the virtualizer's coordinate space. */
  itemStart: number;
  /** The virtualizer's current scroll offset plus its pending adjustments. */
  scrollOffset: number;
  /**
   * The virtualizer's scroll direction while a scroll is in flight
   * ("forward" = down, "backward" = up), null when idle. Present so the rule's
   * independence from it is explicit and tested — see below.
   */
  scrollDirection: "forward" | "backward" | null;
  /** A per-row hold (an in-row disclosure just toggled): that row's resize must leave scrollTop alone. */
  held: boolean;
}

/**
 * Decide whether a row's size change shifts scrollTop by the delta — the
 * virtualizer's `shouldAdjustScrollPositionOnItemSizeChange`.
 *
 * The library rule: a row that starts above the viewport top grew or shrank
 * above the reader, so scrollTop moves by the same amount and the visible
 * content stays put. The one exception is a held row (a tool group opened in
 * place under its chip): that growth is below the visible chip even though the
 * row starts above the viewport, so the shift would throw the chip off the top.
 *
 * The rule must NOT depend on scroll direction. virtual-core's own default
 * skips the shift while scrolling backward, on the assumption that the
 * browser's scroll anchoring handles it; this feed sets overflow-anchor:none,
 * so nothing else compensates. Scrolling UP is exactly when rows above the
 * viewport render for the first time and swap their estimate for a measured
 * height, so with the direction clause every estimate error became a visible
 * lurch under the pointer (measured: 22 jumps, ~3600px, over 60 wheel ticks;
 * none without the clause).
 */
export function shouldAdjustScrollForResize(i: ResizeAdjustInput): boolean {
  if (i.held) return false;
  return i.itemStart < i.scrollOffset;
}

type AdjustVirtualizer = {
  shouldAdjustScrollPositionOnItemSizeChange?: (item: VirtualItem, delta: number, instance: any) => boolean;
};

/**
 * Install the rule on a virtualizer. `held` names a row whose resize must
 * leave scrollTop alone right now (an in-row disclosure the reader toggled).
 */
export function adjustScrollForResizeRule(v: AdjustVirtualizer, held?: (key: VirtualItem["key"]) => boolean) {
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    // getScrollOffset/scrollAdjustments are not on the public type.
    const inst = instance as { getScrollOffset: () => number; scrollAdjustments?: number; scrollDirection: "forward" | "backward" | null };
    return shouldAdjustScrollForResize({
      itemStart: item.start,
      scrollOffset: inst.getScrollOffset() + (inst.scrollAdjustments ?? 0),
      scrollDirection: inst.scrollDirection,
      held: held ? held(item.key) : false,
    });
  };
}
