import { describe, test, expect } from "bun:test";
import { computeDiff } from "./DiffView";

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
