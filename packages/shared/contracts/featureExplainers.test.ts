import { describe, expect, test } from "bun:test";
import { FEATURE_EXPLAINERS } from "./featureExplainers";
import { SNIPPET_CATALOG } from "./snippets";

describe("feature explainers", () => {
  test("every catalog feature, and Stable context, has one", () => {
    const missing = [...SNIPPET_CATALOG.map((s) => s.slug), "stable"].filter((slug) => !FEATURE_EXPLAINERS[slug]);
    expect(missing).toEqual([]);
  });

  test("no explainer for a feature that does not exist", () => {
    const known = new Set([...SNIPPET_CATALOG.map((s) => s.slug), "stable"]);
    expect(Object.keys(FEATURE_EXPLAINERS).filter((k) => !known.has(k))).toEqual([]);
  });

  test("each says something in every part", () => {
    for (const [slug, e] of Object.entries(FEATURE_EXPLAINERS)) {
      expect(`${slug}: ${e.pitch.length > 0 && e.youSee.length > 0 && e.agentsUse.length > 0 && e.tryIt.length > 0}`).toBe(`${slug}: true`);
    }
  });
});
