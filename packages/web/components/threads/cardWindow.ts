import { useLayoutEffect, useRef, type RefObject } from "react";

/** How far below the scroller's top edge the "new" divider lands: enough of
 *  the last read line shows above it to say where the reader left off. */
const DIVIDER_INSET_PX = 28;

/** Where an open row's scroller starts: at its "new" divider when the body
 *  has one — the reader resumes where they left off and reads the news in
 *  order — else at its tail, the newest content. An unpinned scroller
 *  (browsers default to scrollTop 0, oldest on top) would open a long thread
 *  on its first line. Re-pins when `sig` moves (new content landing); a
 *  reader who scrolled away stays put until something new arrives. */
export function useTailPin(sig: unknown): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const divider = el.querySelector<HTMLElement>(".ch-new");
    if (divider) {
      const top = divider.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTop = Math.max(0, top - DIVIDER_INSET_PX);
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [sig]);
  return ref;
}
