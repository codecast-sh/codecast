// Opening a story's drawer keeps the story where it is on screen. Opening one
// closes the drawer open above it, and the page shrinks by that drawer's
// height; the scroll takes up the difference so the story the reader clicked
// does not jump.
//
// The difference can only be measured once the closing drawer has folded.
// Radix keeps every drawer mounted; a closing one stays at full height,
// marked closed, for the commit that closes it, and is hidden in a re-render
// of its own subtree, which this page never sees as a render. So the pin
// waits: it settles in a layout effect when the drawer has already folded,
// else on the mutation that hides it. Nothing here waits on an animation
// frame or an animation end, which a background tab never delivers.
import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

export const storySelector = (key: string) => `[data-story-key="${CSS.escape(key)}"]`;

/** A drawer marked closed that still takes its height: hidden comes a render later. */
const CLOSING = '.chg-drawer[data-state="closed"]:not([hidden])';

type Pin = { key: string; top: number; story: string | undefined };

/**
 * Pin a story's place before a drawer change. `story` is the open story as the
 * page renders it; the pin settles once the page shows `next` and no closing
 * drawer is left. Returns `pinStory(anchor, next)`.
 */
export function useStoryPin(scrollRef: RefObject<HTMLElement | null>, story: string | undefined) {
  const pin = useRef<Pin | null>(null);
  const shown = useRef(story);
  shown.current = story;

  /** Apply the pin when the page is ready for it; true once nothing waits. */
  const settle = useCallback((): boolean => {
    const p = pin.current;
    const root = scrollRef.current;
    if (!p || !root) return true;
    if (shown.current !== p.story || root.querySelector(CLOSING)) return false;
    pin.current = null;
    const el = root.querySelector<HTMLElement>(storySelector(p.key));
    if (!el) return true;
    const delta = el.getBoundingClientRect().top - p.top;
    if (Math.abs(delta) >= 1) root.scrollTop += delta;
    return true;
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (settle()) return;
    const root = scrollRef.current;
    if (!root) return;
    const watch = new MutationObserver(() => {
      if (settle()) watch.disconnect();
    });
    watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state", "hidden"] });
    return () => watch.disconnect();
  });

  return useCallback((anchor: string | undefined, next: string | undefined) => {
    const el = anchor ? scrollRef.current?.querySelector<HTMLElement>(storySelector(anchor)) : null;
    pin.current = anchor && el ? { key: anchor, top: el.getBoundingClientRect().top, story: next } : null;
  }, [scrollRef]);
}
