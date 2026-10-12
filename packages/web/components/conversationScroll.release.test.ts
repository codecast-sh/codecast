import { test, expect } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { releaseScrollTarget } from "./conversationScroll";

// The real virtualizer over a fake scroller whose frames we run by hand.
function setup() {
  const frames: Array<() => void> = [];
  const win = {
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout,
  };
  let onOffset: (offset: number, isScrolling: boolean) => void = () => {};
  const el = {
    scrollTop: 0, clientHeight: 500,
    get scrollHeight() { return v.getTotalSize(); },
    ownerDocument: { defaultView: win },
    addEventListener() {}, removeEventListener() {},
  };
  const v: Virtualizer<any, any> = new Virtualizer({
    count: 50,
    getScrollElement: () => el,
    estimateSize: () => 100,
    observeElementRect: (_i, cb) => { cb({ width: 800, height: 500 }); return () => {}; },
    observeElementOffset: (_i, cb) => { onOffset = cb; cb(0, false); return () => {}; },
    scrollToFn: (offset) => { el.scrollTop = Math.min(offset, el.scrollHeight - el.clientHeight); onOffset(el.scrollTop, false); },
    anchorTo: "end",
    scrollEndThreshold: 8,
  });
  v._didMount();
  v._willUpdate();
  const runFrames = () => { for (let i = 0; i < 10 && frames.length; i++) frames.splice(0).forEach((f) => f()); };
  const readerScrollsTo = (top: number) => { el.scrollTop = top; onOffset(top, true); };
  return { v, el, runFrames, readerScrollsTo };
}

test("a pending scroll-to-end pulls a reader who scrolled away back down when a row grows", () => {
  const { v, el, runFrames, readerScrollsTo } = setup();
  v.scrollToEnd();
  readerScrollsTo(3000);
  v.setOptions({ ...v.options, anchorTo: undefined });
  v.resizeItem(49, 300);
  // The library's own loop, left alone, yanks the reader to the new end.
  runFrames();
  expect(el.scrollTop).toBeGreaterThan(4000);
});

test("releasing the scroll target leaves the reader where they scrolled", () => {
  const { v, el, runFrames, readerScrollsTo } = setup();
  v.scrollToEnd();
  readerScrollsTo(3000);
  releaseScrollTarget(v);
  v.setOptions({ ...v.options, anchorTo: undefined });
  v.resizeItem(49, 300);
  runFrames();
  expect(el.scrollTop).toBe(3000);
});

