import { useState, type RefObject } from "react";
import { useMountEffect } from "./useMountEffect";

/** Has the element come near the viewport yet? Latches true, for a surface
 *  that is expensive to mount and cheap to keep (a media element that holds a
 *  decoder and fetches ranges): a long thread of them mounts only the ones a
 *  reader scrolls to. No IntersectionObserver (a test, an old browser) means
 *  yes at once. */
export function useNearViewport(ref: RefObject<Element | null>, margin = "200px"): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useMountEffect(() => {
    const el = ref.current;
    if (near || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
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
