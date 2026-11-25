import { describe, expect, test } from "bun:test";
import { countMatches, drawnText, parseSearchTerms } from "./index";

describe("drawnText", () => {
  test("drops link and image destinations, keeps the link text", () => {
    const md = "anyone at every.to.\n\nSources:\n- [Every FAQ](https://every.to/faq)\n- ![shot](https://every.to/a.png)\n\n[ref]: https://every.to/team";
    expect(countMatches(drawnText(md), ["every.to"])).toBe(1);
    expect(drawnText("[Every FAQ](https://every.to/faq \"t\")")).toBe("Every FAQ");
  });

  test("keeps links inside code as written", () => {
    const md = "see `[a](https://every.to)` and\n```\n[b](https://every.to/x)\n```\n[c](https://every.to/y)";
    expect(countMatches(drawnText(md), ["every.to"])).toBe(2);
  });

  test("leaves a body with no links untouched", () => {
    const md = "plain https://every.to/faq text";
    expect(drawnText(md)).toBe(md);
  });
});

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
