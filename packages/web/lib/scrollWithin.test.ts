import { describe, expect, test } from "bun:test";
import { scrollTopFor } from "./scrollWithin";

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
});
