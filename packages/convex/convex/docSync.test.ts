import { describe, expect, test } from "bun:test";
import { isRacyEmptySeed } from "./docSync";

// Regression for the doc-content wipe: opening a content-bearing doc in the web
// editor before its markdown prop loaded seeded an empty v1 snapshot, and
// submitSnapshot then overwrote doc.content with "". The guard must reject that
// exact shape (v1 + empty derived markdown + existing content) and nothing else.
describe("isRacyEmptySeed", () => {
  test("THE BUG: v1 empty seed over a doc that still has content is rejected", () => {
    expect(
      isRacyEmptySeed({
        version: 1,
        derivedMarkdown: "",
        existingContent: "# Union Outreach\n\nlots of real content here",
      }),
    ).toBe(true);
  });

  test("a real v1 seed (markdown present) is allowed through", () => {
    expect(
      isRacyEmptySeed({
        version: 1,
        derivedMarkdown: "# Architecture Summary\n\nbody",
        existingContent: "# Architecture Summary\n\nbody",
      }),
    ).toBe(false);
  });

  test("a brand-new empty doc (no existing content) is allowed through", () => {
    expect(isRacyEmptySeed({ version: 1, derivedMarkdown: "", existingContent: "" })).toBe(false);
    expect(isRacyEmptySeed({ version: 1, derivedMarkdown: "", existingContent: undefined })).toBe(false);
    expect(isRacyEmptySeed({ version: 1, derivedMarkdown: "", existingContent: null })).toBe(false);
  });

  test("a genuine full clear of an existing doc (version > 1) is allowed through", () => {
    expect(
      isRacyEmptySeed({ version: 2, derivedMarkdown: "", existingContent: "old content" }),
    ).toBe(false);
    expect(
      isRacyEmptySeed({ version: 137, derivedMarkdown: "", existingContent: "old content" }),
    ).toBe(false);
  });

  test("whitespace is treated as empty on both sides", () => {
    // whitespace-only existing content is not worth protecting
    expect(
      isRacyEmptySeed({ version: 1, derivedMarkdown: "", existingContent: "   \n  " }),
    ).toBe(false);
    // whitespace-only derived markdown still counts as an empty seed
    expect(
      isRacyEmptySeed({ version: 1, derivedMarkdown: "  \n ", existingContent: "real content" }),
    ).toBe(true);
  });
});
