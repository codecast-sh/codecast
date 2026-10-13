// The stage keeps where a person was on each page they left (line-journeys.md
// LJ3): every history entry's scroll is recorded as they scroll, by its
// address, and Back or Forward puts it back once the page is tall enough to
// hold it. Any other move leaves the scroll to the page (opening a finding in
// place keeps where you are). A view may scroll a pane of its own (a problem
// scrolls its detail pane, not the stage): the scroll is kept with the pane's
// class, and restored into the pane of that class once the page has drawn it.
// Timers, not animation frames: a background tab stalls frames, and the
// content a page restores into arrives over several renders.
import { useEffect, useRef, type RefObject } from "react";

type Kept = { pane: string | null; top: number };
const saved = new Map<string, Kept>();
const here = () => `${location.pathname}${location.search}`;
const paneOf = (el: Element, stage: HTMLElement): string | null => (el === stage ? null : el.classList[0] ?? null);

export function useStageScroll(stage: RefObject<HTMLElement | null>, address: string) {
  const popped = useRef(false);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    // Scroll does not bubble: a pane's scroll is caught on its way down.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t === el || el.contains(t))) saved.set(here(), { pane: paneOf(t, el), top: t.scrollTop });
    };
    const onPop = () => { popped.current = true; };
    el.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("popstate", onPop);
    return () => { el.removeEventListener("scroll", onScroll, { capture: true }); window.removeEventListener("popstate", onPop); };
  }, [stage]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const back = popped.current;
    popped.current = false;
    const kept = back ? saved.get(here()) : undefined;
    if (!kept) return;
    // The page fills in over a few renders: hold the restore until its pane is drawn and tall enough, for a little while at most.
    let tries = 0;
    let timer = 0;
    const put = () => {
      const pane = kept.pane ? el.querySelector<HTMLElement>(`.${CSS.escape(kept.pane)}`) : el;
      if (pane) pane.scrollTop = kept.top;
      if ((!pane || Math.abs(pane.scrollTop - kept.top) > 2) && tries++ < 40) timer = window.setTimeout(put, 50);
    };
    put();
    return () => window.clearTimeout(timer);
  }, [stage, address]);
}
