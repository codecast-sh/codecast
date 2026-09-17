import { describe, expect, test } from "bun:test";
import { countMatches, parseSearchTerms } from "./index";

describe("parseSearchTerms", () => {
  test("lowercases words and keeps a quoted phrase whole", () => {
    expect(parseSearchTerms('Facebook "ad spend" x')).toEqual(["facebook", "ad spend", "x"]);
    expect(parseSearchTerms("   ")).toEqual([]);
  });
});

describe("countMatches", () => {
  test("non-overlapping substring count across terms", () => {
    expect(countMatches("aaaa", ["aa"])).toBe(2);
    expect(countMatches("Facebook facebook", ["facebook", "book"])).toBe(4);
    expect(countMatches("x", [""])).toBe(0);
  });
});
