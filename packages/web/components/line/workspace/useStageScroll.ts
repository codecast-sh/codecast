// The stage keeps where a person was on each page they left (line-journeys.md
// LJ3): every history entry's scroll is recorded as they scroll, by its
// address, and Back or Forward puts it back once the page is tall enough to
// hold it. Any other move leaves the scroll to the page (opening a finding in
// place keeps where you are). A view may scroll a pane of its own (a problem
// scrolls its detail pane, not the stage): the scroll is kept with the pane's
// class, and restored into the pane of that class once the page has drawn it.
// Timers, not animation frames: a background tab stalls frames, and the
// content a page restores into arrives over several renders.
import { useCallback, useEffect, useRef } from "react";

type Kept = { pane: string | null; top: number };
const saved = new Map<string, Kept>(); (globalThis as any).__ss = saved; // DEBUG-OTH12
const here = () => `${location.pathname}${location.search}`;
const paneOf = (el: Element, stage: HTMLElement): string | null => (el === stage ? null : el.classList[0] ?? null);

/** Returns the ref for the stage element: a callback, so a stage that mounts after the workspace's first render (behind
 *  its loading state) is still listened to, and attaching costs the workspace no render. */
export function useStageScroll(): (el: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = el ? listen(el) : null;
  }, []);
}

function listen(el: HTMLElement): () => void {
  const heights = new WeakMap<HTMLElement, number>();
  // Scroll does not bubble: a pane's scroll is caught on its way down.
  const onScroll = (e: Event) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || (t !== el && !el.contains(t))) return;
    const pane = paneOf(t, el);
    const was = saved.get(here());
    const shrank = heights.has(t) && t.scrollHeight < heights.get(t)!;
    heights.set(t, t.scrollHeight);
    // A pane that shrank since its last scroll pulled its scroll up with it: the next page drawn into it before the
    // router moves the address (a run opened from a problem), not a person scrolling. The place they left keeps theirs.
    if (shrank && was && was.pane === pane && t.scrollTop < was.top) return;
    saved.set(here(), { pane, top: t.scrollTop });
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
