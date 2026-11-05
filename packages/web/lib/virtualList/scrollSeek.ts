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

export type ScrollSeekOptions = {
  /** Enter seeking above this speed, px per ms. */
  enterPxPerMs?: number;
  /** Leave below this speed, px per ms. */
  exitPxPerMs?: number;
  /** Leave once no scroll event has arrived for this long. */
  idleMs?: number;
  /** How long after an input event a scroll still counts as the reader's. */
  inputWindowMs?: number;
};

export function createScrollSeekTracker(onChange: (seeking: boolean) => void, o: ScrollSeekOptions = {}) {
  const enter = o.enterPxPerMs ?? 4;
  const exit = o.exitPxPerMs ?? 1.5;
  const idleMs = o.idleMs ?? 140;
  const inputWindow = o.inputWindowMs ?? 250;

  let seeking = false;
  let lastTop: number | null = null;
  let lastAt = 0;
  let speed = 0;
  let inputAt = -Infinity;
  let dragging = false;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    if (next === seeking) return;
    seeking = next;
    onChange(next);
  };

  return {
    /** The reader touched an input that scrolls: wheel, touch, a scroll key. */
    input(now: number) { inputAt = now; },
    /** A press on the scrollbar holds reader intent until it is released. */
    drag(held: boolean, now: number) { dragging = held; inputAt = now; },
    scroll(top: number, now: number) {
      if (lastTop !== null && now > lastAt) {
        const v = Math.abs(top - lastTop) / (now - lastAt);
        // Smoothed so one long frame does not toggle it.
        speed = speed === 0 ? v : speed * 0.3 + v * 0.7;
      }
      lastTop = top;
      lastAt = now;
      const reader = dragging || now - inputAt <= inputWindow;
      if (!seeking && reader && speed > enter) set(true);
      else if (seeking && speed < exit) set(false);
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { speed = 0; lastTop = null; set(false); }, idleMs);
    },
    get seeking() { return seeking; },
    dispose() { if (idle) clearTimeout(idle); },
  };
}

/** Wire the tracker to a scroller's own events. Returns the detach. */
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
  const onScroll = () => t.scroll(sc.scrollTop, now());
  sc.addEventListener("wheel", onInput, { passive: true });
  sc.addEventListener("touchmove", onInput, { passive: true });
  sc.addEventListener("keydown", onKey);
  sc.addEventListener("pointerdown", onDown);
  sc.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    t.dispose();
    sc.removeEventListener("wheel", onInput);
    sc.removeEventListener("touchmove", onInput);
    sc.removeEventListener("keydown", onKey);
    sc.removeEventListener("pointerdown", onDown);
    sc.removeEventListener("scroll", onScroll);
  };
}

/**
 * Which rows render as placeholders. On entering a seek, the rows on screen
 * are kept real; every other row is a placeholder until the seek ends.
 */
export function makeSeekKeep() {
  let keep: Set<string> | null = null;
  return {
    begin(keys: Iterable<string | number>) { keep = new Set(Array.from(keys, String)); },
    end() { keep = null; },
    placeholder(key: string | number) { return keep !== null && !keep.has(String(key)); },
  };
}
