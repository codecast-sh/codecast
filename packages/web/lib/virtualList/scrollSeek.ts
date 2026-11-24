import type { VirtualKey } from "./attributeByKey";

// Cheap stand-ins for rows that only fly past.
//
// A fast flick or a scrollbar drag through a long transcript mounts and
// unmounts every row it crosses, each one a markdown render and a layout, for
// rows nobody can read at that speed. While the reader scrolls faster than the
// enter speed, a row that comes into view renders as a placeholder of its
// believed height; rows already on screen when seeking began stay as they are,
// so nothing visible turns into a placeholder. Below the exit speed, or once
// scrolling pauses, every row renders for real. This is react-virtuoso's
// scrollSeekConfiguration.
//
// Only the reader's own scrolling counts. A programmatic jump (a deep link, the
// jump-to-end button) moves thousands of px in one event; seeking there would
// paint the landing as placeholders.
//
// The list's own scroll writes do not count either, even under the reader's
// wheel. A row above the viewport that swaps its estimate for a measured height
// moves scrollTop by the difference so the content on screen stays put: hundreds
// of px in one frame, with nothing moving on screen. Read as speed, that put a
// reader scrolling up at reading pace into a seek, the placeholders then
// measured in as real rows, and those corrections began the next seek (measured
// on a 700-row transcript at 2.9 px/ms, under the enter speed: placeholders in
// 326 of 400 frames). The list reports each write through wrote().
//
// Speed is distance over a window of several frames, never one event against
// the last. Scroll events arrive when the main thread gets to them: a frame
// that renders rows starts late and the next one starts on time, so two events
// a frame's distance apart can land 2 ms apart, and that pair alone reads as a
// fling. Rendering rows is exactly what a scroll at reading pace does.

export type ScrollSeekOptions = {
  /** Enter seeking above this speed, px per ms. */
  enterPxPerMs?: number;
  /** Leave below this speed, px per ms. */
  exitPxPerMs?: number;
  /** Leave once no scroll event has arrived for this long. */
  idleMs?: number;
  /** How long after an input event a scroll still counts as the reader's. */
  inputWindowMs?: number;
  /** Speed is the distance covered over this long, at most. */
  speedWindowMs?: number;
  /** And over this long at least: a shorter stretch decides nothing. */
  minSpanMs?: number;
};

export function createScrollSeekTracker(onChange: (seeking: boolean) => void, o: ScrollSeekOptions = {}) {
  const enter = o.enterPxPerMs ?? 4;
  const exit = o.exitPxPerMs ?? 1.5;
  const idleMs = o.idleMs ?? 140;
  const inputWindow = o.inputWindowMs ?? 250;
  const speedWindow = o.speedWindowMs ?? 80;
  const minSpan = o.minSpanMs ?? 48;

  let seeking = false;
  // The reader's recent positions, oldest first, no older than speedWindow.
  let trail: Array<{ top: number; at: number }> = [];
  let inputAt = -Infinity;
  let dragging = false;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    if (next === seeking) return;
    seeking = next;
    onChange(next);
  };
  const isReader = (now: number) => dragging || now - inputAt <= inputWindow;

  return {
    /** The reader touched an input that scrolls: wheel, touch, a scroll key. */
    input(now: number) { inputAt = now; },
    /** A press on the scrollbar holds reader intent until it is released. */
    drag(held: boolean, now: number) { dragging = held; inputAt = now; },
    scroll(top: number, now: number) {
      trail.push({ top, at: now });
      while (trail.length > 1 && now - trail[0].at > speedWindow) trail.shift();
      const span = now - trail[0].at;
      // Too short a stretch to call: one late frame would decide it.
      if (span >= minSpan) {
        const speed = Math.abs(top - trail[0].top) / span;
        if (!seeking && isReader(now) && speed > enter) set(true);
        else if (seeking && speed < exit) set(false);
      }
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { trail = []; set(false); }, idleMs);
    },
    /** Whether a scroll at `now` can move the state: only the reader's scrolls
     *  enter a seek, and only a seek has anything to leave. */
    wants(now: number) { return seeking || isReader(now); },
    /** A scroll nobody made (the list re-anchoring itself): forget the trail
     *  so the next reader scroll measures from its own start. */
    skip() { trail = []; },
    /** The list set scrollTop to `top` itself. The trail moves with the write,
     *  so the distance it holds stays the reader's own. */
    wrote(top: number) {
      const last = trail[trail.length - 1];
      if (!last) return;
      const moved = Math.max(0, top) - last.top;
      for (const p of trail) p.top += moved;
    },
    /** Whether the reader's hands are on the scroll at `now`. */
    reader: isReader,
    get seeking() { return seeking; },
    dispose() { if (idle) clearTimeout(idle); },
  };
}

/**
 * Wire the tracker to a scroller's own events. `wrote` takes the list's own
 * scroll writes; `reader` says whether the reader is scrolling right now.
 */
export function attachScrollSeek(sc: HTMLElement, onChange: (seeking: boolean) => void, o?: ScrollSeekOptions) {
  const t = createScrollSeekTracker(onChange, o);
  const now = () => performance.now();
  const onInput = () => t.input(now());
  const onKey = (e: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) t.input(now());
  };
  const onDown = (e: PointerEvent) => {
    if (e.target !== sc || e.offsetX <= sc.clientWidth) return;
    t.drag(true, now());
    const up = () => {
      t.drag(false, now());
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  };
  // scrollTop is read only for scrolls that can change the answer: a read
  // during the list's own re-anchoring forces a layout of a changed page.
  const onScroll = () => {
    const at = now();
    if (t.wants(at)) t.scroll(sc.scrollTop, at);
    else t.skip();
  };
  sc.addEventListener("wheel", onInput, { passive: true });
  sc.addEventListener("touchmove", onInput, { passive: true });
  sc.addEventListener("keydown", onKey);
  sc.addEventListener("pointerdown", onDown);
  sc.addEventListener("scroll", onScroll, { passive: true });
  return {
    wrote: (top: number) => t.wrote(top),
    reader: () => t.reader(now()),
    detach() {
      t.dispose();
      sc.removeEventListener("wheel", onInput);
      sc.removeEventListener("touchmove", onInput);
      sc.removeEventListener("keydown", onKey);
      sc.removeEventListener("pointerdown", onDown);
      sc.removeEventListener("scroll", onScroll);
    },
  };
}

/**
 * Which rows render as placeholders. On entering a seek, the rows on screen
 * are kept real; every other row is a placeholder until the seek ends.
 */
export function makeSeekKeep() {
  let keep: Set<string> | null = null;
  return {
    begin(keys: Iterable<VirtualKey>) { keep = new Set(Array.from(keys, String)); },
    end() { keep = null; },
    placeholder(key: VirtualKey) { return keep !== null && !keep.has(String(key)); },
  };
}
