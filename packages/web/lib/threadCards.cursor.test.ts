import { describe, expect, test } from "bun:test";
import { walkIndex } from "./threadCards";

describe("walkIndex", () => {
  test("steps to the neighbour, clamped to the ends", () => {
    expect(walkIndex(5, 2, 1)).toBe(3);
    expect(walkIndex(5, 2, -1)).toBe(1);
    expect(walkIndex(5, 4, 1)).toBe(4);
    expect(walkIndex(5, 0, -1)).toBe(0);
  });

  test("from off the list, down lands on the first and up on the last", () => {
    expect(walkIndex(5, -1, 1)).toBe(0);
    expect(walkIndex(5, -1, -1)).toBe(4);
  });

  test("an empty list has nowhere to land", () => {
    expect(walkIndex(0, -1, 1)).toBe(-1);
  });
});
