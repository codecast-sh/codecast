import { describe, expect, test } from "bun:test";
import { rowScrollDelta } from "../rowScroll";

describe("rowScrollDelta", () => {
  // The rail measured in round 10: scroller top at 0, sticky "Your move"
  // heading 30px tall, both rows of the section scrolled under it.
  const container = { top: 0, bottom: 600 };

  test("a row hidden under the sticky heading scrolls down to clear it", () => {
    expect(rowScrollDelta(container, { top: 17, bottom: 50 }, 32)).toBe(-15);
    expect(rowScrollDelta(container, { top: -45, bottom: -12 }, 32)).toBe(-77);
  });

  test("a row in view below the heading stays put", () => {
    expect(rowScrollDelta(container, { top: 40, bottom: 73 }, 32)).toBe(0);
  });

  test("a row below the fold scrolls up, never past the heading", () => {
    expect(rowScrollDelta(container, { top: 620, bottom: 653 }, 32)).toBe(53);
    expect(rowScrollDelta({ top: 0, bottom: 100 }, { top: 40, bottom: 400 }, 32)).toBe(8);
  });

  test("without a margin it is the plain nearest-edge delta", () => {
    expect(rowScrollDelta(container, { top: -10, bottom: 20 })).toBe(-10);
  });
});
