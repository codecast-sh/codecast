// Landing a link on the Deploys page: each column brings the row the link highlights to its middle and flashes it
// once, following the page as its sections load, until the viewer acts. The page runs it when a link's focus changes.

/** The rows a link highlights, most telling first: a commit waiting in the queue, the deploy that took it, its change on its way. */
const FOCUS_ROWS = [".dpp-commit[data-focus]", "[data-focus] > .dpp-dp-row", ".chb-row[data-focus]"];

/** What scrolls an element: its nearest ancestor that scrolls vertically (a column in two columns, else the pane). */
function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** Whether a row sits more than a couple of pixels off the middle of what scrolls it (the window when nothing does). */
function offCentre(row: Element, scroller: Element | null): boolean {
  const r = row.getBoundingClientRect();
  const s = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  return Math.abs(r.top + r.height / 2 - (s.top + s.height / 2)) > 2;
}

/**
 * Land a link: bring each highlighted row to the middle of whatever scrolls it (each column scrolls on its own, so
 * each brings its own; one scroller takes the most telling), and flash each row once as it first appears. Queues,
 * history and what is on its way arrive on their own clocks and can grow above a row after it is found, so it keeps
 * the rows centred as anything moves, for 6s after the first one appeared. The viewer's own scroll, press, key or a
 * focus moving (a screen reader reading on) ends it, and so does 10s with nothing found.
 */
export function landFocus(): () => void {
  const pane = document.querySelector("[data-deploy-pane]");
  if (!pane) return () => {};
  const flashed = new WeakSet<Element>();
  let frame = 0;
  let cap: ReturnType<typeof setTimeout> | undefined;
  const sized = new ResizeObserver(() => later());
  const center = () => {
    frame = 0;
    // Sections mount late (each reads its own query): watch each as it appears, so its growth re-centres the rows.
    for (const s of pane.querySelectorAll("[data-deploy-col], [data-deploy-col] > *")) sized.observe(s);
    const rows = FOCUS_ROWS.flatMap((sel) => [...pane.querySelectorAll(sel)]);
    if (!rows.length) return;
    const fresh = rows.filter((r) => !flashed.has(r));
    const centred = new Set<Element | null>();
    for (const r of rows) {
      const scroller = scrollerOf(r);
      if (centred.has(scroller)) continue;
      centred.add(scroller);
      // Anything that pushed the row off the middle (a section growing, a banner arriving above) brings it back.
      if (offCentre(r, scroller)) r.scrollIntoView({ block: "center" });
    }
    for (const r of fresh) {
      flashed.add(r);
      r.setAttribute("data-flash", "");
      const done = (e: Event) => { if (e.target !== r) return; r.removeAttribute("data-flash"); r.removeEventListener("animationend", done); };
      r.addEventListener("animationend", done);
    }
    if (!cap) { clearTimeout(give); cap = setTimeout(stop, 6000); }
  };
  function later() { if (!frame) frame = requestAnimationFrame(center); }
  const grows = new MutationObserver(later);
  grows.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-focus", "data-folded"] });
  const give = setTimeout(stop, 10_000);
  function stop() {
    cancelAnimationFrame(frame);
    grows.disconnect();
    sized.disconnect();
    clearTimeout(cap);
    clearTimeout(give);
    for (const e of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) window.removeEventListener(e, stop);
  }
  for (const e of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) window.addEventListener(e, stop, { passive: true });
  later();
  return stop;
}
