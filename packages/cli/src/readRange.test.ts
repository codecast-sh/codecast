import { describe, expect, test } from "bun:test";
import { parseReadRange, sliceBackRange } from "./readRange";

describe("parseReadRange", () => {
  test("forward forms", () => {
    expect(parseReadRange("12:20")).toEqual({ kind: "forward", start: 12, end: 20 });
    expect(parseReadRange("12:")).toEqual({ kind: "forward", start: 12, end: undefined });
    expect(parseReadRange(":20")).toEqual({ kind: "forward", end: 20 });
    expect(parseReadRange("15")).toEqual({ kind: "forward", start: 15, end: 15 });
  });

  test("-c widens one line", () => {
    expect(parseReadRange("15", 3)).toEqual({ kind: "forward", start: 12, end: 18 });
    expect(parseReadRange("2", 3)).toEqual({ kind: "forward", start: 1, end: 5 });
    expect(parseReadRange("-5", 2)).toEqual({ kind: "back", from: 7, to: 3 });
    expect(() => parseReadRange("12:20", 3)).toThrow("-c widens a single line");
  });

  // A tail read labels lines -1, -2 on a long session; those labels read back.
  test("lines counted from the end", () => {
    expect(parseReadRange("-1")).toEqual({ kind: "back", from: 1, to: 1 });
    expect(parseReadRange("-5:")).toEqual({ kind: "back", from: 5, to: 1 });
    expect(parseReadRange("-20:-10")).toEqual({ kind: "back", from: 20, to: 10 });
    expect(() => parseReadRange("-10:-20")).toThrow("runs backwards");
    expect(() => parseReadRange("-0")).toThrow("start at -1");
    expect(() => parseReadRange("-501:")).toThrow("at most 500");
    expect(() => parseReadRange("-5:7")).toThrow("not a message range");
    expect(() => parseReadRange("--full")).toThrow("not a message range");
  });
});

describe("sliceBackRange", () => {
  const msgs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  test("keeps the lines the range names", () => {
    expect(sliceBackRange(msgs, { from: 1, to: 1 })).toEqual([10]);
    expect(sliceBackRange(msgs, { from: 4, to: 2 })).toEqual([7, 8, 9]);
    expect(sliceBackRange(msgs, { from: 5, to: 1 })).toEqual([6, 7, 8, 9, 10]);
  });
  test("a range reaching past the start keeps what exists, and one wholly before it is null", () => {
    expect(sliceBackRange(msgs, { from: 50, to: 8 })).toEqual([1, 2, 3]);
    expect(sliceBackRange(msgs, { from: 50, to: 11 })).toBeNull();
  });
});
