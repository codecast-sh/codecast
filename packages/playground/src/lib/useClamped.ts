import { useLayoutEffect, useState, type RefObject } from "react";

/** Whether the text in `ref`, line-clamped while `open` is false, holds more
 *  than it shows: then the clamp is worth a toggle. Re-measured as the box
 *  resizes; an open box keeps the answer it had. */
export function useClamped(ref: RefObject<HTMLElement | null>, open: boolean, key: unknown): boolean {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, open, key]);
  return clamped;
}
