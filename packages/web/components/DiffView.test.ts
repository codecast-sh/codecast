import { describe, test, expect } from "bun:test";
import { computeDiff, placeDurableThreads, placeSidedThreads } from "./DiffView";

describe("computeDiff", () => {
  test("identical content resolves to all-context without the LCS matrix", () => {
    // Read tool results render through DiffView with oldStr === newStr; this
    // must stay linear or expanding a large file freezes the page.
    const lines = Array.from({ length: 20_000 }, (_, i) => `const line${i} = ${i};`);
    const start = performance.now();
    const result = computeDiff(lines, lines);
    const elapsed = performance.now() - start;

    expect(result.length).toBe(lines.length);
    expect(result.every(l => l.type === "context")).toBe(true);
    expect(result[0].content).toBe(lines[0]);
    expect(result[result.length - 1].content).toBe(lines[lines.length - 1]);
    expect(elapsed).toBeLessThan(500);
  });

  test("insertion in the middle of shared lines", () => {
    const result = computeDiff(["a", "b"], ["a", "x", "b"]);
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "added", content: "x" },
      { type: "context", content: "b" },
    ]);
  });

  test("removal in the middle of shared lines", () => {
    const result = computeDiff(["a", "b", "c"], ["a", "c"]);
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "removed", content: "b" },
      { type: "context", content: "c" },
    ]);
  });

  test("replacement produces removed then added", () => {
    const result = computeDiff(["a", "old", "c"], ["a", "new", "c"]);
    expect(result).toEqual([
      { type: "context", content: "a" },
      { type: "removed", content: "old" },
      { type: "added", content: "new" },
      { type: "context", content: "c" },
    ]);
  });

  test("write-style diff (empty old) marks everything added", () => {
    const result = computeDiff([""], ["a", "b"]);
    expect(result.filter(l => l.type === "added").map(l => l.content)).toEqual(["a", "b"]);
  });

  test("oversized changed region falls back to remove-all/add-all in bounded time", () => {
    // 1500x1500 distinct lines = 2.25M LCS cells, past the cap — must not
    // attempt the quadratic matrix.
    const oldLines = ["same"].concat(Array.from({ length: 1500 }, (_, i) => `old ${i}`), ["same-end"]);
    const newLines = ["same"].concat(Array.from({ length: 1500 }, (_, i) => `new ${i}`), ["same-end"]);
    const start = performance.now();
    const result = computeDiff(oldLines, newLines);
    const elapsed = performance.now() - start;

    expect(result[0]).toEqual({ type: "context", content: "same" });
    expect(result[result.length - 1]).toEqual({ type: "context", content: "same-end" });
    expect(result.filter(l => l.type === "removed").length).toBe(1500);
    expect(result.filter(l => l.type === "added").length).toBe(1500);
    // removed block comes before added block
    const firstAdded = result.findIndex(l => l.type === "added");
    const lastRemoved = result.map(l => l.type).lastIndexOf("removed");
    expect(lastRemoved).toBeLessThan(firstAdded);
    expect(elapsed).toBeLessThan(500);
  });
});


describe("placeDurableThreads", () => {
  const ctx = (oldNum: number, newNum: number) => ({ type: "context" as const, content: "x", oldNum, newNum });
  const add = (newNum: number) => ({ type: "added" as const, content: "x", newNum });
  const del = (oldNum: number) => ({ type: "removed" as const, content: "x", oldNum });
  const sep = { type: "separator" as const };

  test("a commented line lands on the row showing its NEW-side number", () => {
    const items = [ctx(1, 1), del(2), add(2), ctx(3, 3)] as any[];
    const rows = placeDurableThreads(items, new Set([2]));
    // The added row (new line 2) wins over the removed row (old line 2).
    expect(rows.get(2)).toBe(2);
    expect(rows.size).toBe(1);
  });

  test("a comment on a deleted line falls back to the old side", () => {
    const items = [ctx(1, 1), del(2), ctx(3, 2)] as any[];
    const rows = placeDurableThreads(items, new Set([3]));
    // New side has no line 3; old line 3 (the context row) carries it.
    expect(rows.get(2)).toBe(3);
    expect(rows.size).toBe(1);
  });

  test("separators are skipped and each line claims exactly one row", () => {
    const items = [ctx(1, 1), sep, ctx(5, 5), ctx(6, 6)] as any[];
    const rows = placeDurableThreads(items, new Set([5, 6, 99]));
    expect(rows.get(2)).toBe(5);
    expect(rows.get(3)).toBe(6);
    // Line 99 isn't visible in this diff: no row, no crash.
    expect(rows.size).toBe(2);
  });
});


describe("placeSidedThreads", () => {
  const ctx = (oldNum: number, newNum: number) => ({ type: "context" as const, content: "x", oldNum, newNum });
  const add = (newNum: number) => ({ type: "added" as const, content: "x", newNum });
  const del = (oldNum: number) => ({ type: "removed" as const, content: "x", oldNum });
  const sep = { type: "separator" as const };

  test("the two sides of one line land on their own rows", () => {
    // Old line 2 was deleted and new line 2 replaces it. A comment on each is
    // a comment on different code, so each gets the row that shows it.
    const items = [ctx(1, 1), del(2), add(2), ctx(3, 3)] as any[];
    const rows = placeSidedThreads(items, new Set(["LEFT:2", "RIGHT:2"]));
    expect(rows.get(1)).toEqual(["LEFT:2"]);
    expect(rows.get(2)).toEqual(["RIGHT:2"]);
    expect(rows.size).toBe(2);
  });

  test("a context row carries both of its sides", () => {
    const items = [ctx(7, 4)] as any[];
    expect(placeSidedThreads(items, new Set(["LEFT:7"])).get(0)).toEqual(["LEFT:7"]);
    expect(placeSidedThreads(items, new Set(["RIGHT:4"])).get(0)).toEqual(["RIGHT:4"]);
    // Both anchors point at the same row; the new side is read first, and the
    // loser waits for a row of its own rather than doubling up.
    // The row IS old line 7 and new line 4, so a thread on either side belongs
    // there; hosting one and dropping the other would lose a comment.
    const both = placeSidedThreads(items, new Set(["LEFT:7", "RIGHT:4"]));
    expect(both.get(0)?.sort()).toEqual(["LEFT:7", "RIGHT:4"]);
    expect(both.size).toBe(1);
  });

  test("an added row never carries a left anchor, and a deleted row never a right one", () => {
    const items = [add(5), del(5)] as any[];
    const rows = placeSidedThreads(items, new Set(["LEFT:5", "RIGHT:5"]));
    expect(rows.get(0)).toEqual(["RIGHT:5"]);
    expect(rows.get(1)).toEqual(["LEFT:5"]);
  });

  test("separators are skipped and an anchor outside the diff places nothing", () => {
    const items = [ctx(1, 1), sep, ctx(5, 5)] as any[];
    const rows = placeSidedThreads(items, new Set(["RIGHT:5", "RIGHT:99"]));
    expect(rows.get(2)).toEqual(["RIGHT:5"]);
    expect(rows.size).toBe(1);
  });
});


describe("placeSidedThreads over a range", () => {
  const ctx = (oldNum: number, newNum: number) => ({ type: "context" as const, content: "x", oldNum, newNum });
  const add = (newNum: number) => ({ type: "added" as const, content: "x", newNum });

  test("a range hangs under its LAST line, not its first", () => {
    const items = [ctx(1, 1), ctx(2, 2), ctx(3, 3), ctx(4, 4)] as any[];
    const rows = placeSidedThreads(items, new Set(["RIGHT:2-3"]));
    // Row index 2 shows new line 3, the end of the run.
    expect(rows.get(2)).toEqual(["RIGHT:2-3"]);
    expect(rows.size).toBe(1);
  });

  test("a range and a single line ending on the same row both render", () => {
    const items = [ctx(1, 1), ctx(2, 2), ctx(3, 3)] as any[];
    const rows = placeSidedThreads(items, new Set(["RIGHT:1-3", "RIGHT:3"]));
    expect(rows.get(2)?.sort()).toEqual(["RIGHT:1-3", "RIGHT:3"]);
    expect(rows.size).toBe(1);
  });

  test("a range keeps to its own side", () => {
    // Old lines 2 and 3 were deleted; new lines 2 and 3 replace them.
    const items = [ctx(1, 1), { type: "removed" as const, content: "x", oldNum: 2 }, { type: "removed" as const, content: "x", oldNum: 3 }, add(2), add(3)] as any[];
    const rows = placeSidedThreads(items, new Set(["LEFT:2-3", "RIGHT:2-3"]));
    expect(rows.get(2)).toEqual(["LEFT:2-3"]); // the second removed row, old line 3
    expect(rows.get(4)).toEqual(["RIGHT:2-3"]); // the second added row, new line 3
  });

  test("a range whose end line is not visible places nothing", () => {
    const items = [ctx(1, 1), ctx(2, 2)] as any[];
    expect(placeSidedThreads(items, new Set(["RIGHT:1-9"])).size).toBe(0);
  });
});
