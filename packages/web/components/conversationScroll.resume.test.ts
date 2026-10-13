import { test, expect } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { shouldAdjustScrollForResize, shouldFollowStreaming, shouldResumeFollow } from "./conversationScroll";

// The real virtualizer over a fake scroller, with the feed's resize rule, a
// copy of the scroll handler's follow latch, and the size-drift reconciler's
// tick (scroll to the end when within 100px and following). The last row is a
// long reply, taller than the viewport, that keeps streaming.
function setup(rule: (i: { nearBottom: boolean; scrolledDown: boolean; readerMovingDown: boolean }) => boolean) {
  const win = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setTimeout, clearTimeout };
  let userScrolled = false;
  let lastTop = 0;
  let readerMovingDown = false;
  const onScroll = () => {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledDown = el.scrollTop > lastTop + 2;
    if (el.scrollTop < lastTop - 2) userScrolled = true;
    lastTop = el.scrollTop;
    if (rule({ nearBottom: distance < 100, scrolledDown, readerMovingDown })) userScrolled = false;
    v.setOptions({ ...v.options, anchorTo: shouldFollowStreaming(userScrolled) ? "end" : undefined });
  };
  let onOffset: (offset: number, isScrolling: boolean) => void = () => {};
  const el = {
    scrollTop: 0, clientHeight: 500,
    get scrollHeight() { return v.getTotalSize(); },
    ownerDocument: { defaultView: win },
    addEventListener() {}, removeEventListener() {},
  };
  const scrollTo = (top: number) => {
    el.scrollTop = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    onOffset(el.scrollTop, false);
    onScroll();
  };
  const v: Virtualizer<any, any> = new Virtualizer({
    count: 20,
    getScrollElement: () => el,
    estimateSize: (i) => (i === 19 ? 1200 : 100),
    observeElementRect: (_i, cb) => { cb({ width: 800, height: 500 }); return () => {}; },
    observeElementOffset: (_i, cb) => { onOffset = cb; cb(0, false); return () => {}; },
    scrollToFn: (offset, { adjustments = 0 } = {}) => scrollTo(offset + adjustments),
    anchorTo: "end",
    scrollEndThreshold: 8,
  });
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const inst = instance as unknown as { getScrollOffset: () => number; scrollAdjustments: number };
    return shouldAdjustScrollForResize({ itemStart: item.start, scrollOffset: inst.getScrollOffset() + (inst.scrollAdjustments ?? 0), scrollDirection: instance.scrollDirection, held: false });
  };
  v._didMount();
  v._willUpdate();
  const bottom = () => el.scrollHeight - el.clientHeight;
  scrollTo(bottom());
  const readerScrollsUp = (px: number) => scrollTo(el.scrollTop - px);
  const readerScrollsToBottom = () => { readerMovingDown = true; scrollTo(bottom()); readerMovingDown = false; };
  let size = 1200;
  const streamChunk = () => {
    v.resizeItem(19, (size += 40));
    if (distance() < 100 && !userScrolled) scrollTo(bottom());
  };
  const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight;
  return { readerScrollsUp, readerScrollsToBottom, streamChunk, distance };
}

const geometryRule = (i: { nearBottom: boolean; scrolledDown: boolean }) => i.nearBottom && i.scrolledDown;

test("resuming follow on geometry alone snaps a reader who scrolled up a little", () => {
  const { readerScrollsUp, streamChunk, distance } = setup(geometryRule);
  readerScrollsUp(50);
  for (let i = 0; i < 4; i++) streamChunk();
  expect(distance()).toBeLessThan(8);
});

test("a reader who scrolled up a little stays there while the reply streams", () => {
  const { readerScrollsUp, streamChunk, distance } = setup(shouldResumeFollow);
  readerScrollsUp(50);
  for (let i = 0; i < 4; i++) streamChunk();
  expect(distance()).toBe(50);
});

test("scrolling back down to the bottom follows the stream again", () => {
  const { readerScrollsUp, readerScrollsToBottom, streamChunk, distance } = setup(shouldResumeFollow);
  readerScrollsUp(50);
  streamChunk();
  readerScrollsToBottom();
  for (let i = 0; i < 4; i++) streamChunk();
  expect(distance()).toBeLessThan(8);
});
