"use client";

import { useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import {
  followViewSig,
  notifyFollowView,
  readLeaderView,
  registerFollowSurface,
  subscribeFollowSurfaces,
  type FollowScrollKey,
  type FollowSurface,
  type FollowView,
} from "../lib/follow";
import { useWatchEffect } from "./useWatchEffect";

// The in-page half of follow mode (lib/follow.ts). A surface that holds part
// of a person's place (a diff pane's file and line, a panel, a scroller)
// registers here while mounted; the follow hook reads the composed view on
// the leader side and hands each report's parts to the surfaces on the
// follower side, and never names a surface itself.

/** Register `surface` while mounted and `active`. Its functions are read
 *  through a ref, so a surface can close over fresh state every render.
 *  Pass `deps` that change what `read` returns, to tell a leader it moved. */
export function useFollowSurface(surface: FollowSurface, active = true, deps: readonly unknown[] = []): void {
  const ref = useRef(surface);
  ref.current = surface;
  useWatchEffect(() => {
    if (!active) return;
    return registerFollowSurface({
      read: () => ref.current.read?.(),
      apply: (view) => ref.current.apply?.(view) ?? [],
    });
  }, [active]);
  useWatchEffect(() => {
    if (active) notifyFollowView();
  }, [active, ...deps]);
}

/** A hidden pane (a background tab keeps its copy under display: none) is
 *  nobody's place: it neither reports nor takes a scroll. */
function onScreen(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.offsetParent !== null;
}

/** How far down a scroller is, 0 at its top and 1 at its bottom. */
export function scrollOffsetOf(el: HTMLElement): number {
  const room = el.scrollHeight - el.clientHeight;
  return room > 0 ? el.scrollTop / room : 0;
}

/**
 * One scroll region of FOLLOW_SCROLL_REGIONS. The leader reports how far the
 * element has scrolled; the follower scrolls it to the same fraction, and
 * keeps correcting while the content is still growing under it (a doc body
 * arriving, cards taking their real height), letting go the moment the person
 * reaches for the page.
 */
export function useFollowScroll(key: FollowScrollKey, elRef: RefObject<HTMLElement | null>, active = true): void {
  const holdRef = useRef<(() => void) | null>(null);
  useFollowSurface(
    {
      read: () => (onScreen(elRef.current) ? { scroll: { key, offset: scrollOffsetOf(elRef.current) } } : null),
      apply: (view) => {
        const el = elRef.current;
        if (view.scroll?.key !== key || !onScreen(el)) return [];
        holdRef.current?.();
        holdRef.current = holdScroll(el, view.scroll.offset);
        return ["scroll"];
      },
    },
    active,
  );
  // A scroll is a move; the composed view decides whether it is news.
  useWatchEffect(() => {
    const el = elRef.current;
    if (!active || !el) return;
    el.addEventListener("scroll", notifyFollowView, { passive: true });
    return () => {
      el.removeEventListener("scroll", notifyFollowView);
      holdRef.current?.();
    };
  }, [active, elRef.current]);
}

const INTENT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** Put `el` at `offset` and hold it there for a moment while its height
 *  settles. Timers, not frames: a background tab still lands. */
function holdScroll(el: HTMLElement, offset: number): () => void {
  const until = Date.now() + 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const stop = () => {
    done = true;
    if (timer) clearTimeout(timer);
    for (const t of INTENT) el.removeEventListener(t, stop);
  };
  for (const t of INTENT) el.addEventListener(t, stop, { passive: true });
  const step = () => {
    if (done) return;
    const top = Math.round(offset * Math.max(0, el.scrollHeight - el.clientHeight));
    if (Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
    if (Date.now() < until) timer = setTimeout(step, 100);
    else stop();
  };
  step();
  return stop;
}

/**
 * The leader's in-page view, composed from every mounted surface, while
 * `enabled` (someone follows). Re-renders only when the composed view
 * changes, not on every scroll event.
 */
export function useLeaderView(enabled: boolean): { view: FollowView | undefined; sig: string } {
  const sig = useSyncExternalStore(
    enabled ? subscribeFollowSurfaces : noSubscribe,
    () => (enabled ? followViewSig(readLeaderView()) : ""),
    () => "",
  );
  // The sig names the view exactly, so reading again under it is the same view.
  const view = useMemo(() => (sig ? readLeaderView() : undefined), [sig]);
  return { view, sig };
}

const noSubscribe = () => () => {};
