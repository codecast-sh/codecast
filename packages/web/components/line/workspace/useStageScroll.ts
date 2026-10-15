// The stage keeps where a person was on each page they left (line-journeys.md
// LJ3): every history entry's scroll is recorded as they scroll, by its
// address, and Back or Forward puts it back once the page is tall enough to
// hold it. Any other move leaves the scroll to the page (opening a finding in
// place keeps where you are). A view may scroll a pane of its own (a problem
// scrolls its detail pane, not the stage): the scroll is kept with the pane's
// class, and restored into the pane of that class once the page has drawn it.
// Timers, not animation frames: a background tab stalls frames, and the
// content a page restores into arrives over several renders.
import { useCallback, useRef } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";

type Kept = { pane: string | null; top: number };
const saved = new Map<string, Kept>();
const here = () => `${location.pathname}${location.search}`;
const paneOf = (el: Element, stage: HTMLElement): string | null => (el === stage ? null : el.classList[0] ?? null);

/** Returns the ref for the stage element: a callback, so a stage that mounts after the workspace's first render (behind
 *  its loading state) is still listened to, and attaching costs the workspace no render. */
export function useStageScroll(): (el: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  useMountEffect(() => () => detach.current?.());
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = el ? listen(el) : null;
  }, []);
}

function listen(el: HTMLElement): () => void {
  // Scroll does not bubble: a pane's scroll is caught on its way down.
  const onScroll = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t === el || el.contains(t))) saved.set(here(), { pane: paneOf(t, el), top: t.scrollTop });
  };
  let timer = 0;
  // Read what the entry kept the moment it pops: the page leaving can still scroll as it unmounts, and that scroll is
  // recorded under the address being returned to. Then hold the restore until its pane is drawn and tall enough.
  const onPop = () => {
    window.clearTimeout(timer);
    const kept = saved.get(here());
    if (!kept) return;
    let tries = 0;
    const put = () => {
      const pane = kept.pane ? el.querySelector<HTMLElement>(`.${CSS.escape(kept.pane)}`) : el;
      if (pane) pane.scrollTop = kept.top;
      if ((!pane || Math.abs(pane.scrollTop - kept.top) > 2) && tries++ < 60) timer = window.setTimeout(put, 50);
    };
    timer = window.setTimeout(put, 0);
  };
  el.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("popstate", onPop);
  return () => { window.clearTimeout(timer); el.removeEventListener("scroll", onScroll, { capture: true }); window.removeEventListener("popstate", onPop); };
}
