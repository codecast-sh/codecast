// A bottom anchored virtualized list: the scroll behaviour every message stream
// needs, with no knowledge of what a message is.
//
// WHY THIS EXISTS
// ConversationView grew a virtualized message list over many bug reports —
// runaway pagination, overlapping rows under CSS zoom, the "parked at the
// bottom then yanked up a page" jump, a cold open stranded mid conversation.
// The chat surface needs the same behaviour. Copying it would mean every one of
// those bugs gets found and fixed twice, so the behaviour lives here instead and
// both lists call it. ConversationView is being refactored elsewhere right now,
// so its adoption is a follow up; this file is written to fit it.
//
// WHAT IT REPRODUCES FROM ConversationView (behaviour parity, so adoption is
// mechanical):
//   1. A process wide measured height cache, FIFO capped, keyed by the stable
//      row key plus a caller supplied variant key. It survives unmount, so a
//      second open of the same list estimates from real heights instead of a
//      flat guess. That guess was the dominant script cost on a cold switch.
//   2. A measureElement mirror of virtual-core's default that writes into that
//      cache, including the attribution guard: rows stamp their own key as
//      data-vkey and a measurement whose stamp disagrees with the index the
//      virtualizer is about to file it under is discarded. Without the guard a
//      row's height lands under a neighbour's key and never self corrects.
//   3. The virtualizer config: stable getItemKey, overscan, padding, and native
//      chat anchoring (anchorTo:"end", followOnAppend:"auto",
//      scrollEndThreshold:8) gated on a real user scroll latch, so a reader who
//      scrolled up is never pulled back down by an append or a re measure.
//   4. The scroll bookkeeping: atBottom inside a 100px band, near top and near
//      bottom inside wider 200px bands for edge affordances, isScrollable, and
//      the latch itself — any genuine upward scroll latches, reaching the bottom
//      while moving down releases.
//   5. The retry ladder for programmatic scrolls (frame, then 100/300/600ms),
//      because the target offset is computed from estimates that keep moving as
//      rows measure in. It bails the moment the reader scrolls on purpose.
//   6. The initial landing, held for up to 8s against late images and fonts,
//      bailing permanently on a real scroll.
//   7. Pixel exact pagination: capture the topmost visible row and its viewport
//      offset before a page loads, restore that exact offset in a layout effect
//      after it mounts, re pin on the next frame. Loading is armed by WHEEL, one
//      page per gesture — a position trigger is forgeable by the virtualizer's
//      own anchor corrections and rips through every page from one scroll.
//   8. The size drift self heal: once a second, outside active scrolling, feed
//      any row whose DOM height disagrees with the believed size back through
//      resizeItem. Heights measured under the wrong key never heal otherwise —
//      the ResizeObserver only reports CHANGES.
//   9. CSS zoom correctness: rect derived lengths are screen px while scrollTop
//      and row offsets are layout px, so every rect delta is divided by the
//      element's current zoom and heights are read with offsetHeight.
//
// WHAT IT DELIBERATELY DOES NOT DO (these stay in the caller):
//   - Row content, grouping, dividers, density and collapse. The caller passes
//     estimateSize and a variant key; nothing here knows why a row is 200px.
//   - The sticky user message header, the scroll progress rail, story/summary
//     modes, fork selection — ConversationView chrome, not list behaviour.
//   - Deep link "jump to a message that is not loaded yet" with its own settle
//     watcher and pending state. That is a data fetching flow; the hook only
//     offers scrollToIndex.
//   - Deciding WHEN a page exists. The caller owns hasMore/isLoading and the
//     actual fetch; the hook only decides when to ask and holds the view still.
//   - Marking things read, unread rules, counting anything. Timeline maths lives
//     in lib/chatTimeline.ts.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";

// ── Height cache ────────────────────────────────────────────────────────────

// Survives unmount on purpose: switching back to a list, or a row the
// virtualizer recycled while scrolling, gets an accurate estimate instead of a
// flat guess. FIFO capped so a long lived tab stays bounded.
const HEIGHT_CACHE = new Map<string, number>();
const HEIGHT_CACHE_MAX = 8000;

function recordHeight(key: string, size: number) {
  if (HEIGHT_CACHE.has(key)) {
    HEIGHT_CACHE.set(key, size);
    return;
  }
  if (HEIGHT_CACHE.size >= HEIGHT_CACHE_MAX) {
    const oldest = HEIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) HEIGHT_CACHE.delete(oldest);
  }
  HEIGHT_CACHE.set(key, size);
}

/** Exported for tests and for a caller that must invalidate a namespace. */
export function clearBottomAnchoredHeightCache(prefix?: string) {
  if (!prefix) {
    HEIGHT_CACHE.clear();
    return;
  }
  for (const k of [...HEIGHT_CACHE.keys()]) if (k.startsWith(prefix)) HEIGHT_CACHE.delete(k);
}

// The in-app zoom sets CSS zoom on <html>. Under it getBoundingClientRect
// returns screen px (layout px × zoom) while scrollTop, scrollHeight and the
// virtualizer's row offsets stay layout px. Mixing the two halved every believed
// row height at 50% zoom and overlapped the list into garble.
const cssZoomOf = (el: Element): number =>
  (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;

/** True when the viewer asked the system for less animation. Read live rather
 *  than cached at module load, because the setting can change mid session. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// ── Options ─────────────────────────────────────────────────────────────────

export type BottomAnchoredListOptions = {
  /** Number of rows. */
  count: number;
  /** Stable key per row — the pending→synced handoff must keep the same key or
   *  the row is destroyed, re measured and blinks. */
  getItemKey: (index: number) => string;
  /** Height guess for a row the cache has never seen. */
  estimateSize: (index: number) => number;
  /** Namespace for the height cache, e.g. a channel or conversation id. Two
   *  lists must not share entries for the same row key. */
  cacheNamespace: string;
  /** Extra discriminator when one row can render at two heights (collapsed vs
   *  expanded). A row whose variant changed must not read the other's height. */
  rowVariantKey?: (index: number) => string;

  overscan?: number;
  paddingStart?: number;
  paddingEnd?: number;

  /** Where to land on first mount, and on every change of resetKey. Undefined
   *  or null means the bottom, which is what a chat does. An index lands that
   *  row at the top of the viewport — used to open at the unread rule. */
  initialIndex?: number | null;
  /** Changing this re-runs the initial landing: a new channel, a new
   *  conversation. Keep it stable or the list re-snaps under the reader. */
  resetKey?: string;

  /** Older messages exist above and can be fetched. */
  hasMoreAbove?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The mirror, for a window that was opened mid list. */
  hasMoreBelow?: boolean;
  isLoadingNewer?: boolean;
  onLoadNewer?: () => void;

  /** How close to an edge counts as parked there. */
  bottomThresholdPx?: number;
  /** Wider band that hides the edge affordances. */
  edgeBandPx?: number;
};

export type BottomAnchoredList = {
  /** Attach to the scrolling element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Spread onto each row's absolutely positioned wrapper. */
  rowProps: (item: { index: number; key: string | number; start: number }) => {
    key: string | number;
    "data-index": number;
    "data-vkey": string;
    ref: (el: HTMLElement | null) => void;
    style: React.CSSProperties;
  };
  /** Total height for the spacer element. */
  totalSize: number;
  /** Parked at the bottom (within bottomThresholdPx). */
  atBottom: boolean;
  /** Inside the wider bands — use these to hide edge affordances. */
  nearTop: boolean;
  nearBottom: boolean;
  isScrollable: boolean;
  /** The reader scrolled up on purpose. While true, nothing pulls them back. */
  userScrolled: boolean;
  /** Index of the last row with any pixel on screen, or -1. */
  lastVisibleIndex: number;
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  scrollToIndex: (index: number, opts?: { align?: "start" | "center" | "end"; smooth?: boolean }) => void;
};

// ── The hook ────────────────────────────────────────────────────────────────

export function useBottomAnchoredList(opts: BottomAnchoredListOptions): BottomAnchoredList {
  const {
    count,
    getItemKey,
    estimateSize: estimateSizeProp,
    cacheNamespace,
    rowVariantKey,
    overscan = 10,
    paddingStart = 0,
    paddingEnd = 0,
    initialIndex,
    resetKey = "",
    hasMoreAbove,
    isLoadingOlder,
    onLoadOlder,
    hasMoreBelow,
    isLoadingNewer,
    onLoadNewer,
    bottomThresholdPx = 100,
    edgeBandPx = 200,
  } = opts;

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Every position flag is mirrored in a ref: scroll handlers and layout
  // effects read them synchronously, in the same frame the scroll happened.
  const [atBottom, _setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const setAtBottom = useCallback((v: boolean) => { atBottomRef.current = v; _setAtBottom(v); }, []);
  const [nearTop, setNearTop] = useState(true);
  const [nearBottom, setNearBottom] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  const [userScrolled, _setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const setUserScrolled = useCallback((v: boolean) => { userScrolledRef.current = v; _setUserScrolled(v); }, []);

  const lastScrollTopRef = useRef(0);
  // Bridges the render gap between asking for a page and isLoading* flipping,
  // and masks the scroll adjustment a prepend causes so it cannot read as a
  // deliberate scroll up.
  const paginationCooldownRef = useRef(0);
  // One page per wheel gesture. Only a real wheel or touch sets the arm.
  const loadOlderArmedRef = useRef(true);
  const loadNewerArmedRef = useRef(true);

  // Latest props for handlers that live outside React's render (wheel, scroll,
  // interval) and must not be rebound on every render.
  const pageRef = useRef({ hasMoreAbove, isLoadingOlder, onLoadOlder, hasMoreBelow, isLoadingNewer, onLoadNewer });
  pageRef.current = { hasMoreAbove, isLoadingOlder, onLoadOlder, hasMoreBelow, isLoadingNewer, onLoadNewer };

  const heightKey = useCallback(
    (index: number, key: string | number) =>
      `${cacheNamespace}|${key}|${rowVariantKey ? rowVariantKey(index) : ""}`,
    [cacheNamespace, rowVariantKey],
  );

  // A real measured height beats every heuristic: accurate estimates are what
  // stop the measure driven reflow cascade on a cold open.
  const estimateSize = useCallback(
    (index: number) => {
      const cached = HEIGHT_CACHE.get(heightKey(index, getItemKey(index)));
      if (cached !== undefined) return cached;
      return estimateSizeProp(index);
    },
    [heightKey, getItemKey, estimateSizeProp],
  );

  // Mirrors virtual-core's default measureElement and persists what it measures.
  // The attribution guard is the important part: the virtualizer files a
  // measurement under getItemKey(el.dataset.index), but data-index is written at
  // COMMIT time while getItemKey reflects the RENDER time list. Under a deferred
  // update or a prepend those disagree, and the height lands under a neighbour's
  // key — a wrong entry that never heals, because the observer only reports size
  // changes. Each row stamps data-vkey; a disagreement means measure nothing.
  const measureElement = useCallback(
    (element: Element, entry: ResizeObserverEntry | undefined, instance: any) => {
      const horizontal = instance.options.horizontal;
      const index = instance.indexFromElement(element);
      const key = instance.options.getItemKey(index);
      const stamped = (element as HTMLElement).dataset?.vkey;
      if (stamped !== undefined && stamped !== String(key)) {
        return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
      }
      const box = entry?.borderBoxSize?.[0];
      let size: number;
      if (box) {
        size = Math.round(horizontal ? box.inlineSize : box.blockSize);
      } else {
        const cached = instance.itemSizeCache.get(key);
        size = cached !== undefined ? cached : (element as HTMLElement)[horizontal ? "offsetWidth" : "offsetHeight"];
      }
      if (index >= 0) recordHeight(heightKey(index, key), size);
      return size;
    },
    [heightKey],
  );

  // Generics pinned: without them the scroll element widens to `Element` and the
  // returned virtualizer stops matching the hook's own declared return type.
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count,
    getScrollElement: () => containerRef.current,
    getItemKey,
    estimateSize,
    measureElement,
    overscan,
    paddingStart,
    paddingEnd,
    isScrollingResetDelay: 150,
    // Native chat anchoring. The virtualizer owns bottom pinning because it is
    // the only thing that knows whether IT moved the scroll or the user did.
    //   anchorTo:"end"      — within scrollEndThreshold of the bottom, any size
    //                         change re-pins to the bottom, and a prepend keeps
    //                         the visible row stable by key.
    //   followOnAppend      — follow a new row only when already at the tail.
    //   scrollEndThreshold  — small enough that a real scroll up unpins.
    // Both are gated on the upward scroll latch: the library's own proximity
    // heuristic cannot tell streaming growth from intent.
    anchorTo: userScrolled ? undefined : "end",
    followOnAppend: userScrolled ? false : "auto",
    scrollEndThreshold: 8,
  } as any);

  const rowProps = useCallback(
    (item: { index: number; key: string | number; start: number }) => ({
      key: item.key,
      "data-index": item.index,
      "data-vkey": String(item.key),
      ref: virtualizer.measureElement as unknown as (el: HTMLElement | null) => void,
      style: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${item.start}px)`,
      },
    }),
    [virtualizer],
  );

  // ── Programmatic scrolls ──────────────────────────────────────────────────
  // Reassigned every render so the closure always sees the current count and
  // virtualizer. One shot is never enough: the target offset comes from believed
  // sizes, and as rows measure in the end moves by whole screens.
  const scrollToRef = useRef<(target: number | "bottom", o?: { align?: "start" | "center" | "end"; smooth?: boolean; bailOnUserScroll?: boolean }) => void>(() => {});
  scrollToRef.current = (target, o) => {
    const sc = containerRef.current;
    if (!sc) return;
    const pull = () => {
      if (o?.bailOnUserScroll && userScrolledRef.current) return;
      if (target === "bottom") {
        if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
        sc.scrollTop = sc.scrollHeight;
      } else {
        virtualizer.scrollToIndex(target, { align: o?.align ?? "start" });
      }
      // Programmatic scrollTop writes do not reliably emit a scroll event (same
      // value writes, batching), so the virtualizer can paint one frame of the
      // range it had at the previous offset.
      sc.dispatchEvent(new Event("scroll", { bubbles: true }));
    };
    // Smooth is offered only for the bottom, and only as native scrollTo: the
    // virtualizer's own smooth mode is unsupported alongside dynamic
    // measurement, and the retry ladder below would fight the animation anyway.
    // Reduced motion turns it back into a jump.
    if (o?.smooth && target === "bottom" && !prefersReducedMotion()) {
      sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
      setTimeout(pull, 450);
      return;
    }
    pull();
    requestAnimationFrame(pull);
    [100, 300, 600].forEach((ms) => setTimeout(pull, ms));
  };

  const scrollToBottom = useCallback((o?: { smooth?: boolean }) => {
    setUserScrolled(false);
    scrollToRef.current("bottom", { smooth: o?.smooth });
  }, [setUserScrolled]);

  const scrollToIndex = useCallback((index: number, o?: { align?: "start" | "center" | "end"; smooth?: boolean }) => {
    scrollToRef.current(index, o);
  }, []);

  // ── Scroll bookkeeping ────────────────────────────────────────────────────
  useMountEffect(() => {
    const sc = containerRef.current;
    if (!sc) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = sc;
      const fromBottom = scrollHeight - scrollTop - clientHeight;
      setAtBottom(fromBottom < bottomThresholdPx);
      setIsScrollable(scrollHeight > clientHeight + 10);
      setNearTop(scrollTop < edgeBandPx);
      setNearBottom(fromBottom < edgeBandPx);

      const down = scrollTop > lastScrollTopRef.current + 2;
      const up = scrollTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = scrollTop;

      // Latch on ANY genuine upward scroll, not only large ones, so a nudge
      // inside the pin band still registers. The cooldown masks the offset
      // adjustment a freshly mounted page causes.
      if (up && Date.now() >= paginationCooldownRef.current) setUserScrolled(true);
      if (fromBottom < bottomThresholdPx && down) setUserScrolled(false);
    };

    // A wheel or touch is the one signal the virtualizer cannot forge. Arm here,
    // consume in the loader, so a page is pulled once per gesture to an edge.
    const arm = () => {
      loadOlderArmedRef.current = true;
      loadNewerArmedRef.current = true;
      maybeLoadRef.current();
    };

    sc.addEventListener("scroll", onScroll);
    sc.addEventListener("wheel", arm, { passive: true });
    sc.addEventListener("touchmove", arm, { passive: true });
    requestAnimationFrame(onScroll);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("wheel", arm);
      sc.removeEventListener("touchmove", arm);
    };
  });

  // ── Pagination, held pixel exact ──────────────────────────────────────────
  // Remember the topmost visible row and its exact viewport offset; the layout
  // effect below puts it right back after the page mounts, so visible text never
  // moves. The library's own anchor is estimate based and does not hold this.
  const anchorRef = useRef<{ key: string; relTop: number; scrollHeight: number; scrollTop: number; dir: "older" | "newer" } | null>(null);
  const TRIGGER_PX = 600;

  const captureAnchor = (sc: HTMLElement, dir: "older" | "newer") => {
    const scTop = sc.getBoundingClientRect().top;
    let anchorEl: HTMLElement | null = null;
    for (const el of sc.querySelectorAll<HTMLElement>("[data-vkey]")) {
      if (el.getBoundingClientRect().bottom > scTop + 1) { anchorEl = el; break; }
    }
    anchorRef.current = anchorEl
      ? {
          key: anchorEl.dataset.vkey!,
          relTop: (anchorEl.getBoundingClientRect().top - scTop) / cssZoomOf(sc),
          scrollHeight: sc.scrollHeight,
          scrollTop: sc.scrollTop,
          dir,
        }
      : null;
    // If the page never arrives, drop the anchor so a later append cannot be
    // dragged by it.
    const captured = anchorRef.current;
    if (captured) setTimeout(() => { if (anchorRef.current === captured) anchorRef.current = null; }, 3000);
  };

  const maybeLoadRef = useRef<() => void>(() => {});
  maybeLoadRef.current = () => {
    const sc = containerRef.current;
    if (!sc) return;
    const p = pageRef.current;
    const cooling = Date.now() < paginationCooldownRef.current;
    if (cooling || p.isLoadingOlder || p.isLoadingNewer) return;

    if (p.onLoadOlder && p.hasMoreAbove && loadOlderArmedRef.current && sc.scrollTop < TRIGGER_PX) {
      loadOlderArmedRef.current = false;
      captureAnchor(sc, "older");
      paginationCooldownRef.current = Date.now() + 700;
      p.onLoadOlder();
      return;
    }
    if (
      p.onLoadNewer && p.hasMoreBelow && loadNewerArmedRef.current
      && sc.scrollHeight - sc.scrollTop - sc.clientHeight < TRIGGER_PX
    ) {
      loadNewerArmedRef.current = false;
      captureAnchor(sc, "newer");
      paginationCooldownRef.current = Date.now() + 700;
      p.onLoadNewer();
    }
  };

  // Runs after the library's own anchor write and before paint, and targets an
  // ABSOLUTE offset — so it composes with the library anchor instead of double
  // compensating the way an additive delta would.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    const sc = containerRef.current;
    if (!sc) return;
    paginationCooldownRef.current = Date.now() + 500;
    const pinExact = () => {
      const el = sc.querySelector<HTMLElement>(`[data-vkey="${CSS.escape(a.key)}"]`);
      if (!el) return false;
      const correction = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / cssZoomOf(sc) - a.relTop;
      if (correction !== 0) sc.scrollTop += correction;
      lastScrollTopRef.current = sc.scrollTop;
      return true;
    };
    if (!pinExact()) {
      // The anchor fell outside the render window: coarse restore first, then
      // pin exactly next frame. Older pages mount above, so the view shifts by
      // how much the content grew; newer pages mount below, so the pre load
      // offset is still right.
      if (a.dir === "older") {
        const grew = sc.scrollHeight - a.scrollHeight;
        if (grew > 0) { sc.scrollTop += grew; lastScrollTopRef.current = sc.scrollTop; }
      } else {
        sc.scrollTop = a.scrollTop;
        lastScrollTopRef.current = sc.scrollTop;
      }
    }
    requestAnimationFrame(() => { pinExact(); paginationCooldownRef.current = 0; });
  }, [count]);

  // ── Initial landing ───────────────────────────────────────────────────────
  // Held for a while rather than trusted once: late images, fonts and the drift
  // reconciler keep changing heights for seconds after the first paint. It bails
  // permanently the moment the reader scrolls somewhere on purpose.
  const landedRef = useRef<string | null>(null);
  useWatchEffect(() => {
    if (count === 0) return;
    if (landedRef.current === resetKey) return;
    landedRef.current = resetKey;
    setUserScrolled(false);
    lastScrollTopRef.current = 0;
    paginationCooldownRef.current = Date.now() + 1000;

    const target = initialIndex != null && initialIndex >= 0 && initialIndex < count ? initialIndex : "bottom";
    scrollToRef.current(target, { align: "start", bailOnUserScroll: true });

    const start = Date.now();
    const id = setInterval(() => {
      const el = containerRef.current;
      if (!el || userScrolledRef.current || Date.now() - start > 8000) { clearInterval(id); return; }
      if (target === "bottom") {
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 20) {
          scrollToRef.current("bottom", { bailOnUserScroll: true });
        }
      } else {
        // Landing on a row: once it sits at the top, stop. Rows above it keep
        // re measuring, which is exactly what drags it away.
        const row = el.querySelector<HTMLElement>(`[data-index="${target}"]`);
        if (!row) return;
        const off = (row.getBoundingClientRect().top - el.getBoundingClientRect().top) / cssZoomOf(el);
        if (Math.abs(off - paddingStart) > 4) scrollToRef.current(target, { align: "start", bailOnUserScroll: true });
        else clearInterval(id);
      }
    }, 120);
    return () => clearInterval(id);
    // initialIndex intentionally omitted: the landing spot is read once per
    // resetKey. A live unread watermark must not re-snap a reader mid read.
  }, [resetKey, count > 0]);

  // A new list means a fresh landing next time this key comes back.
  useWatchEffect(() => () => { landedRef.current = null; }, [resetKey]);

  // ── Size drift self heal ──────────────────────────────────────────────────
  // A height filed under the wrong key never heals on its own: the observer only
  // reports CHANGES, and attach-measure echoes the cached belief. That is the
  // settled overlapping rows state. Once a second, feed DOM truth back in.
  useWatchEffect(() => {
    const tick = () => {
      const sc = containerRef.current;
      // offsetParent null means a hidden pane: every rect reads 0 there and
      // feeding those through resizeItem would zero the whole layout.
      if (!sc || sc.offsetParent === null) return;
      if (virtualizer.isScrolling) return;
      const byIndex = new Map(virtualizer.getVirtualItems().map((v) => [v.index, v]));
      if (byIndex.size === 0) return;
      const wasAtBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < bottomThresholdPx;
      let corrected = false;
      for (const el of sc.querySelectorAll<HTMLElement>("[data-index]")) {
        const v = byIndex.get(Number(el.dataset.index));
        if (!v || el.dataset.vkey !== String(v.key)) continue; // mid commit row
        // offsetHeight, not a rect: rect heights are screen px under CSS zoom.
        const real = el.offsetHeight;
        if (Math.abs(real - v.size) > 1) {
          virtualizer.resizeItem(v.index, real);
          corrected = true;
        }
      }
      // Healing under a bottom pinned view must keep the reader there, or the
      // last message's tail ends up cut off.
      if (corrected && wasAtBottom && !userScrolledRef.current) {
        virtualizer.scrollToIndex(Math.max(0, count - 1), { align: "end", behavior: "auto" });
      }
    };
    // Plain setInterval, not rAF: rAF never fires in a backgrounded tab and
    // drift must heal there too, so the layout is right on return.
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [virtualizer, count, bottomThresholdPx]);

  const items = virtualizer.getVirtualItems();
  const lastVisibleIndex = useMemo(() => {
    const sc = containerRef.current;
    if (!sc || items.length === 0) return -1;
    const limit = sc.scrollTop + sc.clientHeight;
    let last = -1;
    for (const v of items) if (v.start < limit) last = Math.max(last, v.index);
    return last;
    // items identity changes on every range change, which is exactly when this
    // must be recomputed.
  }, [items]);

  return {
    containerRef,
    virtualizer,
    rowProps,
    totalSize: virtualizer.getTotalSize(),
    atBottom,
    nearTop,
    nearBottom,
    isScrollable,
    userScrolled,
    lastVisibleIndex,
    scrollToBottom,
    scrollToIndex,
  };
}
