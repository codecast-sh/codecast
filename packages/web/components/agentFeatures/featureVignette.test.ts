import { expect, test } from "bun:test";
import { FEATURE_EXPLAINERS } from "@codecast/shared/contracts";
import { VIGNETTE_SLUGS } from "./FeatureVignette";

test("every explained agent feature has a picture", () => {
  const drawn = new Set(VIGNETTE_SLUGS);
  expect(Object.keys(FEATURE_EXPLAINERS).filter((slug) => !drawn.has(slug))).toEqual([]);
});
