import { describe, expect, test } from "bun:test";
import { scrollTopFor, snapToRowEdge } from "./scrollWithin";

// Where a line lands in the one surface that scrolls (the thread, never the
// page around it): centred for a link to a moment, the least move while it
// plays.
describe("scrollTopFor", () => {
  const view = { scrollTop: 400, height: 300 };
  test("center puts the line's middle at the view's middle, or its top at the top when taller", () => {
    expect(scrollTopFor(view, { top: 500, height: 20 }, "center")).toBe(400 + 500 - 140);
    expect(scrollTopFor(view, { top: -200, height: 20 }, "center")).toBe(400 - 200 - 140);
    expect(scrollTopFor(view, { top: 50, height: 400 }, "center")).toBe(450);
    // Already centred: no move at all.
    expect(scrollTopFor(view, { top: 140, height: 20 }, "center")).toBeNull();
  });
  test("nearest leaves a line in view alone and moves one outside it the least", () => {
    expect(scrollTopFor(view, { top: 100, height: 20 }, "nearest")).toBeNull();
    expect(scrollTopFor(view, { top: -30, height: 20 }, "nearest")).toBe(370);
    expect(scrollTopFor(view, { top: 290, height: 20 }, "nearest")).toBe(410);
    // Taller than the view: its top at the top.
    expect(scrollTopFor(view, { top: 320, height: 500 }, "nearest")).toBe(720);
  });
  test("reading puts the line's top a third of the way down, or at the top when it would not fit", () => {
    expect(scrollTopFor(view, { top: 250, height: 20 }, "reading")).toBe(400 + 250 - 100);
    expect(scrollTopFor(view, { top: 100, height: 20 }, "reading")).toBeNull();
    expect(scrollTopFor(view, { top: 50, height: 250 }, "reading")).toBe(450);
  });
});

// The row a landing would slice under the thread's header is shown whole
// instead (content px: offsets from the scroller's content top).
describe("snapToRowEdge", () => {
  const rows = [
    { top: 400, height: 60 }, // a turn
    { top: 420, height: 20 }, // a line inside it
    { top: 460, height: 30 }, // "You started recording"
    { top: 490, height: 80 },
  ];
  test("the edge through a row moves up to the smallest row it cuts", () => {
    expect(snapToRowEdge(427, rows, { top: 520, height: 20 }, 150)).toBe(420);
    expect(snapToRowEdge(470, rows, { top: 520, height: 20 }, 150)).toBe(460);
  });
  test("an edge already between rows stands", () => {
    expect(snapToRowEdge(460, rows, { top: 520, height: 20 }, 150)).toBe(460);
  });
  test("when showing the row whole would push the line out the bottom, the edge goes below it", () => {
    expect(snapToRowEdge(470, rows, { top: 600, height: 20 }, 150)).toBe(490);
    // And when neither keeps the line's top in view, nothing moves.
    expect(snapToRowEdge(500, [{ top: 490, height: 200 }], { top: 660, height: 20 }, 150)).toBe(500);
  });
});
