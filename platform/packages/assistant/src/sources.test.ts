import { describe, expect, test } from "bun:test";
import { formatSources, parseSources } from "./sources";

describe("search sources, both ways", () => {
  test("what formatSources writes after a summary, parseSources reads back", () => {
    const sources = [
      { url: "https://www.tomsguide.com/best-picks/best-robot-vacuums", title: "Best robot vacuums 2026: tested and rated" },
      { url: "https://shopping.yahoo.com/robot-vacuums", title: "Robot vacuums: what to buy" },
      { url: "https://www.eufy.com/robot-vacuums" },
    ];
    expect(parseSources(`The Roborock Q7 leads on suction.${formatSources(sources)}`)).toEqual(sources);
  });

  test("a result with no list has no sources", () => {
    expect(formatSources([])).toBe("");
    expect(parseSources("Nothing reliable was found.")).toEqual([]);
  });

  test("only the trailing list counts, not a summary that mentions sources", () => {
    const text = `Sources: disagree on price.${formatSources([{ url: "https://a.example/x" }])}`;
    expect(parseSources(text)).toEqual([{ url: "https://a.example/x" }]);
  });
});
