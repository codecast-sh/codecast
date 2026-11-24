// Keeps three things agreeing while a reader scrolls a virtualized list: where
// the scroller is, where the virtualizer believes it is, and which rows are in
// the DOM. Each disagreement lasts one frame and is painted.
//
// 1. The virtualizer learns its offset from the scroll event. When it moves
//    scrollTop itself (a row above the viewport measured in taller, so the
//    content on screen is held in place), the event arrives a frame later, and
//    until then it works out the range from the new sizes at the old offset:
//    after a 1,500px correction, a range 1,500px from the view, committed and
//    painted as an empty pane. scrollToFn hands the offset back at once, the
//    way the event will.
// 2. A range change re-renders in a later task, after the frame that needed
//    it. A reader's scroll past the last mounted row commits inside the scroll
//    event; a measurement that moves the range commits in a microtask, before
//    paint (coverage.ts says when), and the rows that commit mounts are
//    measured there too.
// 3. The fast-scroll tracker (scrollSeek.ts) must see the reader's movement
//    only, so every scrollTop the list sets is reported to it.
//
// All of it is for a reader's scroll. A programmatic scroll (the open-at-bottom
// pin, a jump) keeps the batched path: committing synchronously there turned a
// conversation's first paint into a chain of commits.

import { elementScroll, observeElementOffset, type Virtualizer } from "@tanstack/react-virtual";
import { flushSync } from "react-dom";
import { rangeLeftMountedRows, scrollOutranRows, type MountedRows } from "./coverage";

type AnyVirtualizer = Virtualizer<any, any>;
type OffsetCallback = (offset: number, isScrolling: boolean) => void;
type ScrollToOptions = { adjustments?: number; behavior?: ScrollBehavior };

export type ScrollSyncDeps = {
  /** The fast-scroll tracker, once it is attached. */
  seek: () => { wrote: (top: number) => void; reader: () => boolean } | null;
  /** The rows in the DOM as of the last commit. */
  mounted: () => MountedRows | null;
  /** Re-render the list (a state bump); called inside flushSync. */
  commit: () => void;
};

/**
 * Whether a scroll write landed where it aimed. The browser clamps a write to
 * the scroller's range as it stands, and a correction is written before the
 * container has grown: at the tail it lands short, or nowhere. An offset
 * reported from the aim would then name a place the scroller is not, with no
 * scroll event coming to take it back.
 */
export function writeLanded(target: number, scrollTop: number): boolean {
  return Math.abs(scrollTop - target) < 1;
}

/**
 * Give the rows a commit just mounted their real heights now. Their observer
 * entries come a frame late (the browser delivers the observations of rows it
 * began observing during this frame's delivery in the next one), and until
 * then a row stands at its estimate: one taller than that is painted over the
 * rows below it. Every height is read before any is applied, so the page is
 * laid out once for all of them. A placeholder has no height of its own.
 */
function measureMounted(instance: AnyVirtualizer) {
  const fresh: Array<[index: number, size: number]> = [];
  for (const item of instance.getVirtualItems()) {
    if (instance.itemSizeCache.has(item.key)) continue;
    const el = instance.elementsCache.get(item.key) as HTMLElement | undefined;
    if (!el?.isConnected || el.dataset?.seek !== undefined) continue;
    fresh.push([item.index, el.offsetHeight]);
  }
  for (const [index, size] of fresh) instance.resizeItem(index, size);
}

export function createScrollSync(deps: ScrollSyncDeps) {
  let report: ((offset: number) => void) | null = null;
  let commitQueued = false;
  let commitsThisFrame = 0;

  return {
    /** The virtualizer's observeElementOffset option. */
    observeElementOffset(instance: AnyVirtualizer, cb: OffsetCallback) {
      const mine = (offset: number) => cb(offset, instance.isScrolling);
      report = mine;
      const stop = observeElementOffset(instance, (offset, isScrolling) => {
        const outran = isScrolling && !!deps.seek()?.reader() && scrollOutranRows({
          offset,
          viewport: instance.scrollRect?.height ?? 0,
          count: instance.options.count,
          mounted: deps.mounted(),
        });
        if (outran) flushSync(() => cb(offset, isScrolling));
        else cb(offset, isScrolling);
      });
      return () => { if (report === mine) report = null; stop?.(); };
    },

    /** The virtualizer's scrollToFn option. */
    scrollToFn(offset: number, o: ScrollToOptions, instance: AnyVirtualizer) {
      elementScroll(offset, o, instance);
      // A smooth scroll passes through its target over many frames.
      if (o.behavior === "smooth") return;
      const target = Math.max(0, offset + (o.adjustments ?? 0));
      const el = instance.scrollElement as HTMLElement | null;
      // Only a size correction is handed back, and only in a scroller that has
      // a box: in a pane under display:none (a background tab) a write moves
      // nothing. A jump (no adjustments) goes through the virtualizer's own
      // reconcile loop.
      if (!o.adjustments || !el || !((instance.scrollRect?.height ?? 0) > 0)) {
        deps.seek()?.wrote(target);
        return;
      }
      // Where it landed. The write just laid the scroller out to clamp itself,
      // so this read costs no layout of its own.
      const landed = el.scrollTop;
      deps.seek()?.wrote(landed);
      // A clamped write is left to the virtualizer, as it always was: the
      // scroll event brings the true offset if the write moved at all, and if
      // it moved nothing the correction stays owed and goes out with the next.
      if (writeLanded(target, landed)) report?.(target);
    },

    /** Call from the virtualizer's onChange. */
    changed(instance: AnyVirtualizer, sync: boolean) {
      // `sync` is a scroll or a resize of the scroller; the rest are
      // measurements. onChange also fires inside React's commit (a row's
      // measure ref), where flushSync is refused: hence the microtask, which
      // also takes a frame's whole batch of measurements in one commit.
      if (sync || commitQueued || !deps.seek()?.reader()) return;
      const wanted = () => {
        const items = instance.getVirtualItems();
        return rangeLeftMountedRows(deps.mounted(), items[0]?.index, items[items.length - 1]?.index);
      };
      if (!wanted()) return;
      // A measured row can bring in another range, and that one another: two
      // commits a frame, then the batched path takes the rest.
      if (commitsThisFrame >= 2) return;
      commitQueued = true;
      queueMicrotask(() => {
        commitQueued = false;
        if (!wanted()) return;
        if (commitsThisFrame++ === 0 && typeof requestAnimationFrame === "function") requestAnimationFrame(() => { commitsThisFrame = 0; });
        flushSync(deps.commit);
        measureMounted(instance);
      });
    },

    /**
     * A scrollTop written past the virtualizer (the pagination pin sets the
     * scroller directly): tell the tracker and the virtualizer where it is.
     */
    wrote(top: number) {
      deps.seek()?.wrote(top);
      report?.(top);
    },
  };
}

export type ScrollSync = ReturnType<typeof createScrollSync>;
