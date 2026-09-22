import { useLayoutEffect, useRef, type RefObject } from "react";

/** Keep an overflowing card scroller pinned to its tail. The newest content
 *  is what the card is about: an unpinned scroller (browsers default to
 *  scrollTop 0, oldest on top) would open a long thread on its first line
 *  and leave the reply that brought the reader here below the fold. Re-pins
 *  when `sig` moves (new content landing); a reader who scrolled up stays put
 *  until something new arrives. */
export function useTailPin(sig: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sig]);
  return ref;
}
