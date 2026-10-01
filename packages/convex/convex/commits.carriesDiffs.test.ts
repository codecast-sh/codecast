import { describe, expect, it } from "bun:test";
import { commitCarriesDiffs as carries } from "./commits";

// Rows carry counts and statuses beside the patch; the rule reads only the patch.
const commitCarriesDiffs = (files?: Array<{ patch?: string; additions?: number; deletions?: number }>) => carries(files);

describe("a commit row has files only when it has their diffs", () => {
  it("names alone still need the fetch", () => {
    expect(commitCarriesDiffs(undefined)).toBe(false);
    expect(commitCarriesDiffs([])).toBe(false);
    expect(commitCarriesDiffs([{ additions: 0, deletions: 0 }, {}])).toBe(false);
  });
  it("counted lines with no patch (a checkout's numstat publish) still need the fetch", () => {
    expect(commitCarriesDiffs([{ additions: 150, deletions: 0 }, { additions: 23, deletions: 17 }])).toBe(false);
  });
  it("a fetched file whose diff is empty (a binary, a rename) still counts as fetched", () => {
    expect(commitCarriesDiffs([{ patch: "", additions: 0, deletions: 0 }])).toBe(true);
  });
  it("any patch is a diff", () => {
    expect(commitCarriesDiffs([{}, { patch: "@@ -1 +1 @@" }])).toBe(true);
  });
});
