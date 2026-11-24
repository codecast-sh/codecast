import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { attributeMeasurementsByKey } from "../attributeByKey";
import { createScrollHold } from "../scrollHold";

// The real virtualizer over a fake scroller whose frames run by hand.
function setup(keys: string[], estimate = 100) {
  const frames: Array<() => void> = [];
  const win = {
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout,
  };
  let onOffset: (offset: number, isScrolling: boolean) => void = () => {};
  let top = 0;
  const writes: number[] = [];
  const el = {
    get scrollTop() { return top; },
    set scrollTop(t: number) { top = Math.max(0, Math.min(t, el.scrollHeight - el.clientHeight)); writes.push(top); onOffset(top, false); },
    clientHeight: 500,
    get scrollHeight() { return v.getTotalSize(); },
    children: [] as unknown[],
    ownerDocument: { defaultView: win },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  const list = { keys };
  const v: Virtualizer<any, any> = new Virtualizer({
    count: keys.length,
    getItemKey: (i) => list.keys[i] ?? i,
    getScrollElement: () => el,
    estimateSize: () => estimate,
    observeElementRect: (_i, cb) => { cb({ width: 800, height: 500 }); return () => {}; },
    observeElementOffset: (_i, cb) => { onOffset = cb; cb(0, false); return () => {}; },
    scrollToFn: (offset, { adjustments = 0 }) => { el.scrollTop = offset + adjustments; },
  });
  v._didMount();
  v._willUpdate();
  const runFrames = () => { for (let i = 0; i < 20 && frames.length; i++) frames.splice(0).forEach((f) => f()); };
  const setKeys = (next: string[]) => { list.keys = next; v.setOptions({ ...v.options, count: next.length }); };
  return { v, el, runFrames, setKeys, writes };
}

// A rendered row as the observer sees it: data-index from its last commit,
// data-vkey its own key.
const row = (vkey: string | undefined, dataIndex: number) => ({
  dataset: vkey === undefined ? {} : { vkey },
  getAttribute: (name: string) => (name === "data-index" ? String(dataIndex) : null),
});

describe("attributeMeasurementsByKey", () => {
  test("a row whose data-index went stale in a prepend files its height under its own key", () => {
    const { v, setKeys } = setup(["a", "b", "c"]);
    setKeys(["z", "a", "b", "c"]); // render saw the prepend; the DOM still says a is index 0
    const stale = row("a", 0);
    // The library alone files a's height under z.
    expect(v.options.getItemKey(v.indexFromElement(stale as any))).toBe("z");
    attributeMeasurementsByKey(v);
    const index = v.indexFromElement(stale as any);
    expect(index).toBe(1);
    v.resizeItem(index, 333);
    expect(v.itemSizeCache.get("a")).toBe(333);
    expect(v.itemSizeCache.has("z")).toBe(false);
  });

  test("a row whose key left the list measures nothing", () => {
    const { v, setKeys } = setup(["a", "b"]);
    setKeys(["b"]);
    attributeMeasurementsByKey(v);
    expect(v.indexFromElement(row("a", 0) as any)).toBe(-1);
  });

  test("an unstamped element keeps the library's data-index reading", () => {
    const { v } = setup(["a", "b"]);
    attributeMeasurementsByKey(v);
    attributeMeasurementsByKey(v); // re-applied every render, never wraps itself
    expect(v.indexFromElement(row(undefined, 1) as any)).toBe(1);
  });
});

describe("createScrollHold", () => {
  afterEach(() => setSystemTime());
  // onChange re-aims in a microtask (it fires inside React's commit).
  const settle = () => Promise.resolve();

  test("a bottom hold re-aims when rows grow after the library let go", async () => {
    const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    const hold = createScrollHold(v, () => el as any);
    hold.set("bottom", { holdMs: 1000 });
    runFrames();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
    // An image in a row above loads 300ms later: the library's loop is done.
    v.resizeItem(40, 600);
    hold.onChange();
    await settle();
    runFrames();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
  });

  // Each re-aim reads the scroller's geometry (a forced layout). Bursts of size
  // changes inside one frame re-aim once there, and once more at the next
  // frame's start, still before it paints.
  test("size bursts inside one frame re-aim once, then at the next frame", async () => {
    const queued: Array<() => void> = [];
    const realRaf = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (fn: () => void) => { queued.push(fn); return queued.length; };
    try {
      const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
      const hold = createScrollHold(v, () => el as any);
      hold.set("bottom", { holdMs: 1000 });
      runFrames();
      // Only the hold reads scrollTop (the virtualizer hears offsets through
      // its observer), so its reads count the re-aims.
      let reads = 0;
      const top = Object.getOwnPropertyDescriptor(el, "scrollTop")!;
      Object.defineProperty(el, "scrollTop", { get() { reads++; return top.get!.call(el); }, set(t: number) { top.set!.call(el, t); }, configurable: true });
      v.resizeItem(40, 600);
      hold.onChange();
      await settle();
      const afterFirst = reads;
      expect(afterFirst).toBeGreaterThan(0);
      v.resizeItem(41, 600);
      hold.onChange();
      await settle();
      expect(reads).toBe(afterFirst);
      queued.splice(0).forEach((f) => f());
      expect(reads).toBeGreaterThan(afterFirst);
      runFrames();
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
    } finally {
      (globalThis as any).requestAnimationFrame = realRaf;
    }
  });

  test("an idle hold writes nothing when sizes have not moved", async () => {
    const { v, el, runFrames, writes } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    const hold = createScrollHold(v, () => el as any);
    hold.set("bottom", { holdMs: 1000 });
    runFrames();
    const n = writes.length;
    hold.onChange();
    hold.onChange();
    await settle();
    expect(writes.length).toBe(n);
  });

  test("a released hold leaves the reader where they are", async () => {
    const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    const hold = createScrollHold(v, () => el as any);
    hold.set("bottom", { holdMs: 1000 });
    runFrames();
    hold.release();
    el.scrollTop = 2000;
    v.resizeItem(45, 400); // below the view: only a hold could move the reader
    hold.onChange();
    await settle();
    runFrames();
    expect(el.scrollTop).toBe(2000);
    expect(hold.active).toBe(false);
  });

  test("the bail predicate ends the hold", async () => {
    const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    let scrolledUp = false;
    const hold = createScrollHold(v, () => el as any);
    hold.set("bottom", { holdMs: 1000, bail: () => scrolledUp });
    runFrames();
    scrolledUp = true;
    el.scrollTop = 1000;
    v.resizeItem(45, 500);
    hold.onChange();
    await settle();
    runFrames();
    expect(el.scrollTop).toBe(1000);
    expect(hold.active).toBe(false);
  });

  test("the hold lapses after its visible budget", async () => {
    const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    setSystemTime(new Date(1_000_000));
    const hold = createScrollHold(v, () => el as any);
    hold.set("bottom", { holdMs: 1000 });
    runFrames();
    setSystemTime(new Date(1_000_000 + 1500));
    el.scrollTop = 1000;
    v.resizeItem(45, 500);
    hold.onChange();
    await settle();
    expect(hold.active).toBe(false);
    expect(el.scrollTop).toBe(1000);
  });

  test("an index hold keeps the row at the top while rows above it measure in", async () => {
    const { v, el, runFrames } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    const hold = createScrollHold(v, () => el as any);
    hold.set({ index: 30, align: "start" }, { holdMs: 8000 });
    runFrames();
    expect(el.scrollTop).toBe(3000);
    v.resizeItem(5, 250);
    hold.onChange();
    await settle();
    runFrames();
    expect(el.scrollTop).toBe(3150);
  });
});

import { createScrollSeekTracker, makeSeekKeep } from "../scrollSeek";

describe("scroll seek", () => {
  const run = (steps: Array<[top: number, at: number, input?: boolean]>) => {
    const seen: boolean[] = [];
    const t = createScrollSeekTracker((s) => seen.push(s), { idleMs: 10_000 });
    for (const [top, at, input] of steps) { if (input) t.input(at); t.scroll(top, at); }
    t.dispose();
    return { seen, seeking: t.seeking };
  };

  test("a fast reader flick enters seeking and slowing down leaves it", () => {
    const { seen } = run([[0, 0, true], [160, 16, true], [320, 32, true], [480, 48, true], [500, 64, true], [505, 80, true], [506, 96, true], [506, 112, true], [506, 128, true], [506, 144, true]]);
    expect(seen).toEqual([true, false]);
  });

  test("a programmatic jump of thousands of px never seeks", () => {
    const { seen } = run([[0, 0], [40_000, 16], [40_000, 32]]);
    expect(seen).toEqual([]);
  });

  test("slow reading never seeks", () => {
    const { seen } = run([[0, 0, true], [20, 16, true], [40, 32, true], [60, 48, true], [80, 64, true], [100, 80, true]]);
    expect(seen).toEqual([]);
  });

  test("reading pace with late frames never seeks", () => {
    // 25 px a frame at 120 Hz, 3 px/ms. Every third frame renders rows and
    // starts 6 ms late, so the one after it lands 2 ms behind: 12 px/ms between
    // that pair.
    const steps: Array<[number, number, boolean]> = [];
    for (let f = 0; f < 60; f++) steps.push([f * 25, f * 8 + (f % 3 === 0 ? 6 : 0), true]);
    expect(run(steps).seen).toEqual([]);
  });

  test("the distance scrolled during a stall counts with the stall", () => {
    // A steady 3 px/ms. A page of older messages mounts for 67 ms: the event
    // that ends the stall carries one frame's distance, and the 200px scrolled
    // meanwhile arrives in the next event, 16 ms later.
    const steps: Array<[number, number, boolean]> = [];
    let top = 0, at = 0;
    for (let f = 0; f < 8; f++) { steps.push([top, at, true]); top += 48; at += 16; }
    at += 51;
    steps.push([top, at, true]);
    top += 200; at += 16;
    for (let f = 0; f < 8; f++) { steps.push([top, at, true]); top += 48; at += 16; }
    expect(run(steps).seen).toEqual([]);
  });

  test("and when it arrives over the two events after the stall", () => {
    const steps: Array<[number, number, boolean]> = [];
    let top = 0, at = 0;
    for (let f = 0; f < 8; f++) { steps.push([top, at, true]); top += 48; at += 16; }
    at += 51;
    steps.push([top, at, true]);
    top += 100; at += 16;
    steps.push([top, at, true]);
    top += 148; at += 16;
    for (let f = 0; f < 8; f++) { steps.push([top, at, true]); top += 48; at += 16; }
    expect(run(steps).seen).toEqual([]);
  });

  test("a fling that begins right after a stall still seeks", () => {
    const steps: Array<[number, number, boolean]> = [[0, 0, true], [48, 16, true], [96, 83, true]];
    let top = 96, at = 83;
    for (let f = 0; f < 10; f++) { top += 160; at += 16; steps.push([top, at, true]); }
    expect(run(steps).seen).toEqual([true]);
  });

  // A row above the viewport measured in 400px taller than its estimate and
  // the list moved scrollTop by the same amount, mid-scroll, at reading pace.
  const correction: Array<[top: number, at: number]> = [[0, 0], [20, 16], [440, 32], [460, 48], [480, 64], [500, 80]];

  test("the list's own scroll correction under the reader's wheel never seeks", () => {
    const seen: boolean[] = [];
    const t = createScrollSeekTracker((s) => seen.push(s), { idleMs: 10_000 });
    for (const [top, at] of correction) {
      t.input(at);
      if (top === 440) t.wrote(420);
      t.scroll(top, at);
    }
    t.dispose();
    expect(seen).toEqual([]);
  });

  test("the same jump, unreported, reads as a fling", () => {
    const { seen } = run(correction.map(([top, at]) => [top, at, true]));
    expect(seen[0]).toBe(true);
  });

  test("a fling still seeks through the list's corrections", () => {
    const seen: boolean[] = [];
    const t = createScrollSeekTracker((s) => seen.push(s), { idleMs: 10_000 });
    let top = 0;
    for (let at = 0; at <= 160; at += 16) {
      t.input(at);
      if (at === 32) { top += 300; t.wrote(top); }
      top += 160;
      t.scroll(top, at);
    }
    t.dispose();
    expect(seen).toEqual([true]);
  });

  test("a write before the reader has scrolled leaves nothing to measure from", () => {
    const seen: boolean[] = [];
    const t = createScrollSeekTracker((s) => seen.push(s), { idleMs: 10_000 });
    t.wrote(5_000);
    t.input(0);
    t.scroll(5_000, 0);
    t.scroll(5_020, 16);
    t.dispose();
    expect(seen).toEqual([]);
  });

  test("the reader is scrolling for a moment after each input, and while dragging the scrollbar", () => {
    const t = createScrollSeekTracker(() => {}, { idleMs: 10_000, inputWindowMs: 250 });
    expect(t.reader(0)).toBe(false);
    t.input(100);
    expect(t.reader(300)).toBe(true);
    expect(t.reader(400)).toBe(false);
    t.drag(true, 500);
    expect(t.reader(5_000)).toBe(true);
    t.drag(false, 5_000);
    expect(t.reader(5_300)).toBe(false);
    t.dispose();
  });

  test("rows on screen when seeking began stay real", () => {
    const keep = makeSeekKeep();
    expect(keep.placeholder("a")).toBe(false);
    keep.begin(["a", 7]);
    expect(keep.placeholder("a")).toBe(false);
    expect(keep.placeholder("7")).toBe(false);
    expect(keep.placeholder("b")).toBe(true);
    keep.end();
    expect(keep.placeholder("b")).toBe(false);
  });
});

import { scrollOutranRows } from "../coverage";

describe("scrollOutranRows", () => {
  // Rows 10..20 are in the DOM, covering offsets 2000..4000 of a 100-row list.
  const mounted = { firstIndex: 10, start: 2000, lastIndex: 20, end: 4000 };
  const at = (offset: number, m: typeof mounted | null = mounted, count = 100) => scrollOutranRows({ offset, viewport: 600, count, mounted: m });

  test("a viewport inside the mounted rows is covered", () => {
    expect(at(2000)).toBe(false);
    expect(at(3400)).toBe(false);
  });

  test("a scroll past either edge of the mounted rows is not", () => {
    expect(at(1999)).toBe(true);
    expect(at(3401)).toBe(true);
    expect(at(40_000)).toBe(true);
  });

  test("past the first and the last row of the list there is nothing to mount", () => {
    expect(at(0, { firstIndex: 0, start: 16, lastIndex: 20, end: 4000 })).toBe(false);
    expect(at(3900, { firstIndex: 10, start: 2000, lastIndex: 99, end: 4000 })).toBe(false);
  });

  test("an empty list, or a scroller not laid out yet, asks for nothing", () => {
    expect(at(500, null)).toBe(false);
    expect(scrollOutranRows({ offset: 0, viewport: 0, count: 100, mounted })).toBe(false);
  });
});

import { createScrollSync, writeLanded } from "../scrollSync";
import { rangeLeftMountedRows } from "../coverage";

describe("rangeLeftMountedRows", () => {
  const mounted = { firstIndex: 10, start: 2000, lastIndex: 20, end: 4000 };
  test("the same first and last row is the same range", () => {
    expect(rangeLeftMountedRows(mounted, 10, 20)).toBe(false);
  });
  test("a range that starts or ends on another row has left the DOM's", () => {
    expect(rangeLeftMountedRows(mounted, 9, 20)).toBe(true);
    expect(rangeLeftMountedRows(mounted, 10, 24)).toBe(true);
  });
  test("with nothing mounted, or no range, there is nothing to commit", () => {
    expect(rangeLeftMountedRows(null, 10, 20)).toBe(false);
    expect(rangeLeftMountedRows(mounted, undefined, undefined)).toBe(false);
  });
});

describe("scroll sync", () => {
  // The real virtualizer with scrollSync's two hooks, over a scroller that
  // clamps writes the way a browser does and emits no events of its own.
  function synced(opts: { boxed?: boolean; reader?: boolean } = {}) {
    const seekWrites: number[] = [];
    const commits: number[] = [];
    const sync = createScrollSync({
      seek: () => ({ wrote: (top) => { seekWrites.push(top); }, reader: () => opts.reader ?? true }),
      mounted: () => mounted.value,
      commit: () => { commits.push(1); },
    });
    const mounted: { value: { firstIndex: number; start: number; lastIndex: number; end: number } | null } = { value: null };
    let top = 0;
    let scrollHeight = 10_000;
    const el = {
      get scrollTop() { return top; },
      scrollTo(o: { top: number }) { top = Math.max(0, Math.min(o.top, scrollHeight - 500)); },
      clientHeight: 500,
      get scrollHeight() { return scrollHeight; },
      ownerDocument: { defaultView: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setTimeout, clearTimeout, performance } },
      addEventListener() {}, removeEventListener() {},
    };
    const v: Virtualizer<any, any> = new Virtualizer({
      count: 100,
      getItemKey: (i) => `k${i}`,
      getScrollElement: () => el,
      estimateSize: () => 100,
      observeElementRect: (_i, cb) => { cb({ width: 800, height: opts.boxed === false ? 0 : 500 }); return () => {}; },
      observeElementOffset: sync.observeElementOffset,
      scrollToFn: sync.scrollToFn,
      onChange: (instance, s) => sync.changed(instance, s),
    });
    v._didMount();
    v._willUpdate();
    v.shouldAdjustScrollPositionOnItemSizeChange = (item) => item.start < (v.scrollOffset ?? 0);
    // What a scroll event does: the offset the scroller is at.
    const scrolled = (to: number) => { top = to; sync.wrote(to); seekWrites.length = 0; };
    return { v, el, sync, seekWrites, commits, mounted, scrolled, setScrollHeight: (h: number) => { scrollHeight = h; } };
  }

  test("a correction above the viewport reaches the virtualizer before any scroll event", () => {
    const { v, el, seekWrites, scrolled } = synced();
    scrolled(3000);
    // Row 5 (above the viewport) measures in 1,500px taller than its estimate.
    v.resizeItem(5, 1600);
    expect(el.scrollTop).toBe(4500);
    expect(v.scrollOffset).toBe(4500);
    expect(seekWrites).toEqual([4500]);
    // The same rows are in range as before the correction.
    expect(v.getVirtualItems().some((it) => it.index === 30)).toBe(true);
  });

  test("corrections in one batch add up from the offset already handed back", () => {
    const { v, el, scrolled } = synced();
    scrolled(3000);
    v.resizeItem(5, 1600);
    v.resizeItem(6, 400);
    expect(el.scrollTop).toBe(4800);
    expect(v.scrollOffset).toBe(4800);
  });

  test("a write the scroller clamps is not handed back: the virtualizer keeps the offset the scroller is at", () => {
    const { v, el, seekWrites, scrolled, setScrollHeight } = synced();
    // The reader sits at the scroller's end; the container grows only after the write.
    setScrollHeight(3500);
    scrolled(3000);
    v.resizeItem(5, 1600);
    expect(el.scrollTop).toBe(3000);
    expect(v.scrollOffset).toBe(3000);
    expect(seekWrites).toEqual([3000]);
  });

  test("a pane without a box hands nothing back", () => {
    const { v, scrolled } = synced({ boxed: false });
    scrolled(3000);
    v.resizeItem(5, 1600);
    expect(v.scrollOffset).toBe(3000);
  });

  test("a jump is the tracker's to know and the virtualizer's own to reconcile", () => {
    const { v, seekWrites } = synced();
    seekWrites.length = 0;
    v.scrollToOffset(4000);
    expect(seekWrites).toEqual([4000]);
    // Nothing handed back: the virtualizer's offset waits for the scroll event.
    expect(v.scrollOffset).toBe(0);
  });

  test("a measurement that moves the range under a reader's scroll commits before the frame ends, once", async () => {
    const { v, commits, mounted, scrolled } = synced();
    scrolled(3000);
    const items = v.getVirtualItems();
    mounted.value = { firstIndex: items[0].index, start: items[0].start, lastIndex: items[items.length - 1].index, end: items[items.length - 1].end };
    // Two visible rows shrink to nothing: more rows belong on screen now.
    v.resizeItem(31, 0);
    v.resizeItem(32, 0);
    expect(commits).toEqual([]);
    await Promise.resolve();
    expect(commits).toEqual([1]);
  });

  test("the rows that commit mounted are measured in the same frame, placeholders left alone", async () => {
    const { v, mounted, scrolled } = synced();
    scrolled(3000);
    const items = v.getVirtualItems();
    mounted.value = { firstIndex: items[0].index, start: items[0].start, lastIndex: items[items.length - 1].index, end: items[items.length - 1].end };
    v.resizeItem(31, 0);
    v.resizeItem(32, 0);
    // The commit mounts the rows the new range adds: one real, one placeholder.
    const added = v.getVirtualItems().filter((it) => it.index > mounted.value!.lastIndex);
    expect(added.length).toBeGreaterThanOrEqual(2);
    v.elementsCache.set(added[0].key, { isConnected: true, dataset: {}, offsetHeight: 640 } as any);
    v.elementsCache.set(added[1].key, { isConnected: true, dataset: { seek: "" }, offsetHeight: 100 } as any);
    await Promise.resolve();
    expect(v.itemSizeCache.get(added[0].key)).toBe(640);
    expect(v.itemSizeCache.has(added[1].key)).toBe(false);
  });

  test("the same measurement with no reader scrolling waits for the next batch", async () => {
    const { v, commits, mounted, scrolled } = synced({ reader: false });
    scrolled(3000);
    const items = v.getVirtualItems();
    mounted.value = { firstIndex: items[0].index, start: items[0].start, lastIndex: items[items.length - 1].index, end: items[items.length - 1].end };
    v.resizeItem(31, 0);
    v.resizeItem(32, 0);
    await Promise.resolve();
    expect(commits).toEqual([]);
  });

  test("a measurement that leaves the range alone commits nothing", async () => {
    const { v, commits, mounted, scrolled } = synced();
    scrolled(3000);
    const items = v.getVirtualItems();
    mounted.value = { firstIndex: items[0].index, start: items[0].start, lastIndex: items[items.length - 1].index, end: items[items.length - 1].end };
    v.resizeItem(5, 1600);
    await Promise.resolve();
    expect(commits).toEqual([]);
  });

  test("writeLanded allows for sub-pixel rounding and nothing more", () => {
    expect(writeLanded(4500, 4500.4)).toBe(true);
    expect(writeLanded(4500, 3000)).toBe(false);
  });
});

import { adjustScrollForResizeRule } from "../resizeAdjust";

describe("adjustScrollForResizeRule", () => {
  // The reader scrolls up from 3000 to 2900; row 20 (start 2000, above the
  // view) then measures 300px taller than its estimate.
  const scrollUpThenMeasure = (install: boolean) => {
    const { v, el } = setup(Array.from({ length: 50 }, (_, i) => `k${i}`));
    if (install) adjustScrollForResizeRule(v);
    el.scrollTop = 3000;
    (v as any).scrollDirection = "backward";
    (v as any).isScrolling = true;
    v.resizeItem(20, 400);
    return el.scrollTop;
  };

  test("without the rule, an upward scroll leaves the view to lurch", () => {
    expect(scrollUpThenMeasure(false)).toBe(3000);
  });

  test("with the rule, the view moves with the row so the content stays put", () => {
    expect(scrollUpThenMeasure(true)).toBe(3300);
  });
});
