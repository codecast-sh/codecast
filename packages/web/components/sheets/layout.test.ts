import { describe, expect, test } from "bun:test";
import { AxisLayout } from "./layout";

describe("AxisLayout", () => {
  test("default sizes", () => {
    const a = new AxisLayout(10_000, 24, new Map());
    expect(a.total).toBe(240_000);
    expect(a.offset(1)).toBe(0);
    expect(a.offset(101)).toBe(2400);
    expect(a.indexAt(2399)).toBe(100);
    expect(a.indexAt(2400)).toBe(101);
    expect(a.span(0, 240)).toEqual([1, 10]);
  });
  test("custom sizes and hidden rows", () => {
    const a = new AxisLayout(10, 100, new Map([[2, 200], [4, 0], [5, 0]]));
    expect(a.total).toBe(900);
    expect(a.offset(3)).toBe(300);
    expect(a.offset(4)).toBe(400);
    expect(a.offset(6)).toBe(400);
    expect(a.offset(11)).toBe(900);
    expect(a.indexAt(150)).toBe(2);
    expect(a.indexAt(400)).toBe(6);
    expect(a.sizeOf(4)).toBe(0);
    expect(a.step(3, 1)).toBe(6);
    expect(a.step(6, -1)).toBe(3);
    expect(a.step(1, -1)).toBe(1);
  });
  test("consistency: indexAt inverts offset everywhere", () => {
    const custom = new Map<number, number>();
    for (let i = 3; i < 500; i += 7) custom.set(i, (i % 3) * 40);
    const a = new AxisLayout(500, 24, custom);
    for (let i = 1; i <= 500; i++) {
      if (a.sizeOf(i) === 0) continue;
      expect(a.indexAt(a.offset(i))).toBe(i);
      expect(a.offset(i + 1) - a.offset(i)).toBe(a.sizeOf(i));
    }
  });
});
