import { describe, expect, it } from "bun:test";
import { commitCarriesDiffs } from "./commits";

describe("a commit row has files only when it has their diffs", () => {
  it("names alone still need the fetch", () => {
    expect(commitCarriesDiffs(undefined)).toBe(false);
    expect(commitCarriesDiffs([])).toBe(false);
    expect(commitCarriesDiffs([{ additions: 0, deletions: 0 }, {}])).toBe(false);
  });
  it("a fetched file whose diff is empty (a binary, a rename) still counts as fetched", () => {
    expect(commitCarriesDiffs([{ patch: "", additions: 0, deletions: 0 }])).toBe(true);
  });
  it("any patch or any counted change is a diff", () => {
    expect(commitCarriesDiffs([{}, { patch: "@@ -1 +1 @@" }])).toBe(true);
    expect(commitCarriesDiffs([{ additions: 3 }])).toBe(true);
    expect(commitCarriesDiffs([{ deletions: 1 }])).toBe(true);
  });
});
