import { describe, expect, test } from "bun:test";
import { isRacyEmptyOverwrite } from "./docSync";

// Regression for the two doc-content wipes: opening a content-bearing doc in
// the web editor before its markdown prop loaded either (a) seeded an empty v1
// snapshot (June 2026 incident), or (b) on a CLI-edited doc, had
// ExternalEditSync setContent("") replace the whole doc at version > 1 (July
// 2026 incident, wiped s97a49h5). submitSnapshot then overwrote doc.content
// with "". The guard must reject both shapes and nothing else.
describe("isRacyEmptyOverwrite", () => {
  test("JUNE BUG: v1 empty seed over a doc that still has content is rejected", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "",
        existingContent: "# Union Outreach\n\nlots of real content here",
        cliEditedAt: null,
      }),
    ).toBe(true);
  });

  test("JULY BUG: v>1 empty overwrite of a CLI-edited doc is rejected", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 4,
        derivedMarkdown: "",
        existingContent: "# Cold email throughput\n\n5kB of real analysis",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(true);
  });

  test("a real v1 seed (markdown present) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "# Architecture Summary\n\nbody",
        existingContent: "# Architecture Summary\n\nbody",
        cliEditedAt: null,
      }),
    ).toBe(false);
  });

  test("a normal edit of a CLI-edited doc (markdown present) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 7,
        derivedMarkdown: "# Doc\n\nedited in the browser",
        existingContent: "# Doc\n\nolder text",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(false);
  });

  test("a brand-new empty doc (no existing content) is allowed through", () => {
    for (const existingContent of ["", undefined, null] as const) {
      expect(
        isRacyEmptyOverwrite({ version: 1, derivedMarkdown: "", existingContent, cliEditedAt: null }),
      ).toBe(false);
      expect(
        isRacyEmptyOverwrite({
          version: 3,
          derivedMarkdown: "",
          existingContent,
          cliEditedAt: 1784105015602,
        }),
      ).toBe(false);
    }
  });

  test("a genuine full clear of a web-only doc (version > 1, no CLI stamp) is allowed through", () => {
    expect(
      isRacyEmptyOverwrite({
        version: 2,
        derivedMarkdown: "",
        existingContent: "old content",
        cliEditedAt: null,
      }),
    ).toBe(false);
    expect(
      isRacyEmptyOverwrite({
        version: 137,
        derivedMarkdown: "",
        existingContent: "old content",
        cliEditedAt: undefined,
      }),
    ).toBe(false);
  });

  test("whitespace is treated as empty on both sides", () => {
    // whitespace-only existing content is not worth protecting
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "",
        existingContent: "   \n  ",
        cliEditedAt: null,
      }),
    ).toBe(false);
    // whitespace-only derived markdown still counts as an empty overwrite
    expect(
      isRacyEmptyOverwrite({
        version: 1,
        derivedMarkdown: "  \n ",
        existingContent: "real content",
        cliEditedAt: null,
      }),
    ).toBe(true);
    expect(
      isRacyEmptyOverwrite({
        version: 5,
        derivedMarkdown: "  \n ",
        existingContent: "real content",
        cliEditedAt: 1784105015602,
      }),
    ).toBe(true);
  });
});
