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
    const { seen } = run([[0, 0, true], [160, 16, true], [320, 32, true], [340, 48, true], [345, 64, true], [346, 80, true]]);
    expect(seen).toEqual([true, false]);
  });

  test("a programmatic jump of thousands of px never seeks", () => {
    const { seen } = run([[0, 0], [40_000, 16], [40_000, 32]]);
    expect(seen).toEqual([]);
  });

  test("slow reading never seeks", () => {
    const { seen } = run([[0, 0, true], [20, 16, true], [40, 32, true], [60, 48, true]]);
    expect(seen).toEqual([]);
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
