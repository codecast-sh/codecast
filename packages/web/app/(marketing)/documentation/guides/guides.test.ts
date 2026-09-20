import { describe, expect, test } from "bun:test";
import { GUIDES, GUIDE_CATEGORIES, guideHref } from "./guides";
import { getGuideContent } from "./guideContent";
import { RELEASES } from "../../changelog/changelogData";
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

// A guide is three registrations: the registry row, the markdown body, and a
// category the docs page renders. A changelog card links to guides by href.
// Each of these drifts in silence, as a blank page or a dead link.
describe("guide registry integrity", () => {
  test("every guide has a body and a category the docs page renders", () => {
    for (const guide of GUIDES) {
      expect(getGuideContent(guide.slug)?.length ?? 0, `${guide.slug} has no markdown body`).toBeGreaterThan(0);
      expect(GUIDE_CATEGORIES as readonly string[]).toContain(guide.category);
    }
  });

  test("every changelog deep dive link resolves to a registered guide", () => {
    const hrefs = new Set(GUIDES.map((g) => guideHref(g.slug)));
    for (const release of RELEASES) {
      for (const section of release.sections) {
        for (const doc of section.docs ?? []) {
          expect(hrefs.has(doc.href), `${release.id} "${section.title}" links to ${doc.href}`).toBe(true);
        }
      }
    }
  });
});
