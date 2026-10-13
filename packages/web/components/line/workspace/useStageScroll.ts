// The stage keeps where a person was on each page they left (line-journeys.md
// LJ3): every history entry's scroll is recorded as they scroll, by its
// address, and Back or Forward puts it back once the page is tall enough to
// hold it. Any other move leaves the scroll to the page (opening a finding in
// place keeps where you are).
// Timers, not animation frames: a background tab stalls frames, and the
// content a page restores into arrives over several renders.
import { useEffect, useRef, type RefObject } from "react";

const saved = new Map<string, number>();
const here = () => `${location.pathname}${location.search}`;

export function useStageScroll(stage: RefObject<HTMLElement | null>, address: string) {
  const popped = useRef(false);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onScroll = () => saved.set(here(), el.scrollTop);
    const onPop = () => { popped.current = true; };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onPop);
    return () => { el.removeEventListener("scroll", onScroll); window.removeEventListener("popstate", onPop); };
  }, [stage]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const back = popped.current;
    popped.current = false;
    if (!back) return;
    const want = saved.get(here()) ?? 0;
    // The page fills in over a few renders: hold the restore until it is tall enough, for a little while at most.
    let tries = 0;
    let timer = 0;
    const put = () => {
      el.scrollTop = want;
      if (Math.abs(el.scrollTop - want) > 2 && tries++ < 30) timer = window.setTimeout(put, 50);
    };
    put();
    return () => window.clearTimeout(timer);
  }, [stage, address]);
}
