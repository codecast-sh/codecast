// One pending scroll target, held until the layout stops moving under it.
//
// A programmatic scroll aims at an offset computed from believed row heights.
// virtual-core's scrollToIndex re-aims every frame until one frame is stable,
// which covers the rows measuring in right after the jump. What it misses is
// the long tail: an image, a font or an embed that changes a row's height
// hundreds of milliseconds later, after the library already let go.
//
// A hold re-aims on exactly those events and nothing else: a size change the
// virtualizer reports (fed through onChange) or a resize of any other content
// in the scroller (a lead block, a footer, the spacer itself). No timers poll
// it, so an idle hold costs nothing. It ends when the reader takes the view
// (release), when the caller's bail predicate says so, or after its time
// limit. The limit counts only time the document is visible: a background tab
// paints and measures nothing, so a hold that ran out there would never have
// seen the heights it was waiting for.

export type HoldTarget =
  | "bottom"
  | "top"
  | { index: number; align: "start" | "center" | "end" };

type HoldVirtualizer = {
  options: { count: number };
  getTotalSize: () => number;
  scrollToIndex: (index: number, o?: { align?: "start" | "center" | "end" | "auto"; behavior?: "auto" | "smooth" }) => void;
  getOffsetForIndex: (index: number, align?: "start" | "center" | "end" | "auto") => readonly [number, string] | undefined;
  scrollOffset?: number | null;
};

type Hold = {
  target: HoldTarget;
  bail?: () => boolean;
  /** Visible milliseconds left before the hold lapses. */
  budget: number;
  /** When the budget was last charged, or null while the document is hidden. */
  since: number | null;
};

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** True when the scroller already shows the target within a pixel. */
export function holdSatisfied(sc: HTMLElement, v: HoldVirtualizer, target: HoldTarget): boolean {
  if (target === "bottom") return sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 1;
  if (target === "top") return sc.scrollTop <= 0;
  const info = v.getOffsetForIndex(target.index, target.align);
  return !info || Math.abs(info[0] - sc.scrollTop) <= 1;
}

export function createScrollHold(v: HoldVirtualizer, getEl: () => HTMLElement | null) {
  let hold: Hold | null = null;
  let lastTotal = -1;
  let ro: ResizeObserver | null = null;
  let observed: HTMLElement | null = null;
  let applyQueued = false;

  const charge = (h: Hold) => {
    const now = Date.now();
    if (h.since !== null) h.budget -= now - h.since;
    h.since = hidden() ? null : now;
    return h.budget > 0;
  };

  const stop = () => {
    hold = null;
    ro?.disconnect();
    observed = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };

  const apply = () => {
    const h = hold;
    const sc = getEl();
    if (!h || !sc) return;
    if (!charge(h) || h.bail?.()) { stop(); return; }
    if (holdSatisfied(sc, v, h.target)) return;
    const count = v.options.count;
    if (h.target === "bottom") {
      if (count > 0) v.scrollToIndex(count - 1, { align: "end" });
      sc.scrollTop = sc.scrollHeight;
    } else if (h.target === "top") {
      if (count > 0) v.scrollToIndex(0, { align: "start" });
      sc.scrollTop = 0;
    } else {
      v.scrollToIndex(Math.min(h.target.index, Math.max(0, count - 1)), { align: h.target.align });
    }
    // A programmatic write does not reliably emit a scroll event (same value
    // writes, batching), so the virtualizer could paint a frame of the range it
    // had at the previous offset.
    sc.dispatchEvent(new Event("scroll", { bubbles: true }));
  };

  function onVisibility() {
    const h = hold;
    if (!h) return;
    charge(h);
    if (!hidden()) apply();
  }

  const watch = (sc: HTMLElement) => {
    if (observed === sc) return;
    ro?.disconnect();
    observed = sc;
    if (typeof ResizeObserver === "undefined") return;
    ro ??= new ResizeObserver(() => apply());
    ro.observe(sc);
    for (const child of Array.from(sc.children)) ro.observe(child);
  };

  return {
    /** Aim at `target` now and keep it there for `holdMs` of visible time. */
    set(target: HoldTarget, o: { holdMs: number; bail?: () => boolean }) {
      const sc = getEl();
      if (!sc) return;
      if (!hold && typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
      hold = { target, bail: o.bail, budget: o.holdMs, since: hidden() ? null : Date.now() };
      lastTotal = v.getTotalSize();
      watch(sc);
      apply();
    },
    /** Feed the virtualizer's onChange here. Re-aims only when sizes moved,
     *  in a microtask: onChange fires inside React's commit (a row's measure
     *  ref), and a scroll written there re-enters the virtualizer's own sync
     *  onChange, whose flushSync React refuses mid-commit. The microtask still
     *  runs before the frame paints. */
    onChange() {
      const h = hold;
      if (!h) return;
      const total = v.getTotalSize();
      if (total === lastTotal) return;
      lastTotal = total;
      if (!charge(h) || h.bail?.()) { stop(); return; }
      if (applyQueued) return;
      applyQueued = true;
      queueMicrotask(() => { applyQueued = false; apply(); });
    },
    /** The reader took the view. */
    release: stop,
    get active() { return hold !== null; },
    get target() { return hold?.target ?? null; },
  };
}

export type ScrollHold = ReturnType<typeof createScrollHold>;
