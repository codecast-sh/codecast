import { describe, expect, test } from "bun:test";
import { GUIDES } from "./guides";
import { allSnippetSlugs } from "@codecast/shared/contracts";

// Every guide that documents an installable feature names its `cast install`
// slug. The invariant is NOT "the slug is in SNIPPET_CATALOG": `stable` is a
// SessionStart hook with a tri-state mode, deliberately outside the catalog,
// and asserting catalog membership would force it in or force the guide to
// lie. The rule is: a catalog slug, or the literal "stable".
describe("guide installSlug invariant", () => {
  test("every installSlug is a catalog slug or the literal stable", () => {
    const valid = new Set([...allSnippetSlugs(), "stable"]);
    for (const guide of GUIDES) {
      if (guide.installSlug === undefined) continue;
      expect(valid.has(guide.installSlug),
        `${guide.slug} names installSlug "${guide.installSlug}", which is neither a catalog slug nor "stable"`,
      ).toBe(true);
    }
  });

  test("stable is genuinely outside the catalog, or this test's reason is gone", () => {
    // If stable ever joins SNIPPET_CATALOG, the special case above stops
    // pulling its weight and should be deleted with it.
    expect(allSnippetSlugs()).not.toContain("stable");
  });
});
