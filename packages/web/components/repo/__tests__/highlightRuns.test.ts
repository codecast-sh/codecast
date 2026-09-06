// GitHub hands back a fragment plus offsets into it, and those offsets are not
// guaranteed sorted, non-overlapping or even inside the string. Emitting them
// naively duplicates characters, which silently corrupts the code a person is
// reading, so every run here reassembles to the original fragment.
import { describe, expect, test } from "bun:test";
import { highlightRuns } from "../../../lib/highlightRuns";

const rebuild = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

describe("highlightRuns", () => {
  test("marks the matched span and leaves the rest alone", () => {
    const runs = highlightRuns("const repoSearch = 1", [[6, 16]]);
    expect(runs).toEqual([
      { text: "const ", hit: false },
      { text: "repoSearch", hit: true },
      { text: " = 1", hit: false },
    ]);
  });

  test("handles several matches given out of order", () => {
    const runs = highlightRuns("a b a", [[4, 5], [0, 1]]);
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(["a", "a"]);
    expect(rebuild(runs)).toBe("a b a");
  });

  test("overlapping spans never duplicate characters", () => {
    // The naive version emits "repo" twice and shows the reader code that is
    // not in the file.
    const runs = highlightRuns("repoSearch", [[0, 6], [2, 8]]);
    expect(rebuild(runs)).toBe("repoSearch");
  });

  test("a fragment with no matches is one plain run", () => {
    expect(highlightRuns("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });

  test("degenerate spans are dropped rather than trusted", () => {
    // end <= start, and NaN from a malformed payload.
    const runs = highlightRuns("abc", [[2, 2], [Number.NaN, 2] as [number, number]]);
    expect(rebuild(runs)).toBe("abc");
    expect(runs.some((r) => r.hit)).toBe(false);
  });

  test("a match running to the end emits no trailing empty run", () => {
    const runs = highlightRuns("abc", [[1, 3]]);
    expect(runs).toEqual([{ text: "a", hit: false }, { text: "bc", hit: true }]);
  });
});
