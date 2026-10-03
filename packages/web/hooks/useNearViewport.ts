import { useState, type RefObject } from "react";
import { useMountEffect } from "./useMountEffect";

/** Is the element near the viewport? By default it latches true once it has
 *  been, for a surface that is costly to start and cheap to keep (a query
 *  subscription shared by every card of the same object): a long thread
 *  starts only the ones a reader scrolls to. `latch: false` keeps answering,
 *  for a surface that is costly to hold (a media element with a decoder and a
 *  buffer): it mounts as the reader nears it and is let go once they are far
 *  past, so a thread of them never holds more than the screen's worth. No
 *  IntersectionObserver (a test, an old browser) means yes at once. */
export function useNearViewport(ref: RefObject<Element | null>, margin = "200px", { latch = true }: { latch?: boolean } = {}): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useMountEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        // The last entry is the element's current state when several queue up.
        const now = entries[entries.length - 1]?.isIntersecting ?? false;
        if (!latch) return setNear(now);
        if (!now) return;
        setNear(true);
        io.disconnect();
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  });
  return near;
}
