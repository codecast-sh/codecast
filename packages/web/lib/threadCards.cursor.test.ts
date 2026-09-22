import { describe, expect, test } from "bun:test";
import { afterDone, walkIndex } from "./threadCards";

// The reader's cursor: where j/k land, and where "done" steps to.

describe("walkIndex", () => {
  test("steps to the neighbour and clamps at the ends", () => {
    expect(walkIndex(5, 2, 2, 1)).toBe(3);
    expect(walkIndex(5, 2, 2, -1)).toBe(1);
    expect(walkIndex(5, 4, 4, 1)).toBe(4);
    expect(walkIndex(5, 0, 0, -1)).toBe(0);
  });

  test("with no cursor on the list, a walk down lands on the row that took the gone row's place", () => {
    // The cursor stood at index 2 and its row left: index 2 is now the next row.
    expect(walkIndex(5, -1, 2, 1)).toBe(2);
    expect(walkIndex(5, -1, 2, -1)).toBe(1);
    // A fresh page starts at the top either way.
    expect(walkIndex(5, -1, 0, 1)).toBe(0);
    expect(walkIndex(5, -1, 0, -1)).toBe(0);
  });

  test("an empty list has nowhere to land", () => {
    expect(walkIndex(0, -1, 0, 1)).toBe(-1);
  });
});

describe("afterDone", () => {
  test("the next row, else the previous, else none", () => {
    expect(afterDone(["a", "b", "c"], 1)).toBe("c");
    expect(afterDone(["a", "b", "c"], 2)).toBe("b");
    expect(afterDone(["a"], 0)).toBeUndefined();
  });
});
