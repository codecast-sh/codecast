// settleTimelineItemAtOffset against a fake scroller: it pins the row at the
// offset and reports once; a re-measure above the row (height and position
// move together) is corrected; a scroll it did not write while the height
// stood still (a host landing on a card inside the row, a scrollbar drag) is a
// takeover, and the watch stops rather than pulling the view back (W1).
// Run: bun test --timeout 240000 components/conversationScroll.settle.test.ts
import { expect, test } from "bun:test";
import { settleTimelineItemAtOffset } from "./conversationScroll";

(globalThis as any).requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);

const VIEW_TOP = 100;
const OFFSET = 50;

/** A scroller with one row at `rowTop` layout px from the content's top. */
function fakeFeed(rowTop: number) {
  const feed = {
    scrollTop: 0,
    scrollHeight: 20_000,
    rowTop,
    writes: [] as number[],
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ top: VIEW_TOP }),
    querySelector: () => row,
  };
  const row = {
    isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ top: VIEW_TOP + feed.rowTop - feed.scrollTop }),
  };
  // Every scrollTop write is recorded, so the test can tell the settle's own from its own.
  let top = 0;
  Object.defineProperty(feed, "scrollTop", { get: () => top, set: (v: number) => { top = v; feed.writes.push(v); } });
  return feed;
}
const virtualizer = { scrollToIndex() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOffset = (feed: ReturnType<typeof fakeFeed>) => feed.rowTop - feed.scrollTop;

test("pins the row at the offset, reports once, and keeps correcting a re-measure above it", async () => {
  const feed = fakeFeed(3000);
  let settled = 0;
  settleTimelineItemAtOffset(feed as any, virtualizer, 7, OFFSET, { initialDelayMs: 0, watchMs: 400, onSettled: () => { settled++; } });
  await sleep(80);
  expect(rowOffset(feed)).toBe(OFFSET);
  expect(settled).toBe(1);
  // Rows above measure taller: the content grows and the row moves down with it.
  feed.scrollHeight += 300;
  feed.rowTop += 300;
  await sleep(80);
  expect(rowOffset(feed)).toBe(OFFSET);
  expect(settled).toBe(1);
});

test("a scroll it did not write, under an unchanged height, ends the watch where that scroll left the view", async () => {
  const feed = fakeFeed(3000);
  settleTimelineItemAtOffset(feed as any, virtualizer, 7, OFFSET, { initialDelayMs: 0, watchMs: 400 });
  await sleep(80);
  expect(rowOffset(feed)).toBe(OFFSET);
  // The host lands on a card 600px inside the row.
  feed.scrollTop += 600;
  const after = feed.scrollTop;
  const writes = feed.writes.length;
  await sleep(150);
  expect(feed.scrollTop).toBe(after);
  expect(feed.writes.length).toBe(writes);
  // The watch is over: a later re-measure above is nobody's to correct here.
  feed.scrollHeight += 300;
  feed.rowTop += 300;
  await sleep(80);
  expect(feed.scrollTop).toBe(after);
});

test("a host that scrolls from inside onSettled is honoured, never corrected on the next frame", async () => {
  const feed = fakeFeed(3000);
  let landed = 0;
  settleTimelineItemAtOffset(feed as any, virtualizer, 7, OFFSET, {
    initialDelayMs: 0,
    watchMs: 400,
    onSettled: () => { feed.scrollTop += 1322; landed = feed.scrollTop; },
  });
  await sleep(200);
  expect(landed).toBeGreaterThan(0);
  expect(feed.scrollTop).toBe(landed);
});
