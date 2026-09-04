import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
// The Threads page's mount window. With unread cards open by default, dozens
// of expanded bodies would each mount a feeder (channel messages, session
// messages, task detail) at once. Instead the card SHELL always renders, and
// the heavy body mounts only while the card is near the viewport — the same
// IntersectionObserver-sentinel pattern the inbox list and GenericListView
// use for their load-more edges, applied per card. A far card holds its place
// with a ghost of the body's last measured height, so swapping bodies in and
// out never moves the scroll position. The margin is the mount cap: at most
// ~viewport + 2×NEAR_MARGIN of bodies exist at any moment, however long the
// list grows.

/** How far past the viewport a card keeps its body mounted. Generous enough
 *  that a body mounts (and its feeder loads) before the reader reaches it. */
const NEAR_MARGIN = "900px 0px";

/** Whether the element is within NEAR_MARGIN of the viewport. `defaultNear`
 *  covers the first frame, before the observer's initial callback: the first
 *  screenful should paint bodies, not ghosts. */
export function useNearViewport(ref: RefObject<Element | null>, defaultNear: boolean): boolean {
  const [near, setNear] = useState(defaultNear);
  useMountEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: NEAR_MARGIN });
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  return near;
}

/** Whether any pixel of the element is actually IN the viewport (no margin) —
 *  the read law's witness. False whenever disabled (body not mounted). */
export function useOnScreen(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useWatchEffect(() => {
    if (!enabled) {
      setSeen(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => setSeen(e.isIntersecting));
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return seen;
}

/** Keep an overflowing card scroller pinned to its tail. The newest content
 *  is what the card is about, and the shell's read sentinel sits in page flow
 *  below the scroller — its geometry says "the scroller's bottom edge was in
 *  the viewport", which is the newest message ONLY while the scroller rests
 *  at its tail. An unpinned scroller (browsers default to scrollTop 0, oldest
 *  on top) would mark long threads read on a scroll-past without the newest
 *  line ever rendering. Re-pins when `sig` moves (new content landing), the
 *  rule SessionRows established; a reader who scrolled up stays put until
 *  something new arrives. */
export function useTailPin(sig: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sig]);
  return ref;
}

// Body heights by card id, page-lifetime. A ghost with the body's real height
// keeps scroll geometry identical across the swap; the fallback only covers a
// body that has never mounted, which by construction is still ~900px away.
const bodyHeights = new Map<string, number>();

const GHOST_FALLBACK_PX = 320;

export function ghostHeight(cardId: string): number {
  return bodyHeights.get(cardId) ?? GHOST_FALLBACK_PX;
}

/** Ref callback for the mounted body wrapper: records its height (and follows
 *  it as messages land) so the ghost that replaces it holds the same space. */
export function useBodyMeasure(cardId: string): (el: HTMLDivElement | null) => void {
  const roRef = useRef<ResizeObserver | null>(null);
  return useCallback(
    (el: HTMLDivElement | null) => {
      roRef.current?.disconnect();
      roRef.current = null;
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const h = el.offsetHeight;
        if (h > 0) bodyHeights.set(cardId, h);
      });
      ro.observe(el);
      roRef.current = ro;
    },
    [cardId],
  );
}
