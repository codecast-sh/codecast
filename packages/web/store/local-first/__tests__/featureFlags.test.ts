import { describe, expect, test } from "bun:test";
import { readLocalFirstFeatureFlags } from "../featureFlags";

describe("local-first rollout flags", () => {
  test("defaults every rail off", () => {
    expect(readLocalFirstFeatureFlags({})).toEqual({
      buckets: "off",
      comments: "off",
      smallViews: "off",
      messageSend: "off",
    });
  });

  test("per-slice values cannot activate without the global rail", () => {
    expect(readLocalFirstFeatureFlags({
      VITE_LOCAL_FIRST_BUCKETS_MODE: "cutover",
      VITE_LOCAL_FIRST_COMMENTS_MODE: "shadow",
    })).toEqual({
      buckets: "off",
      comments: "off",
      smallViews: "off",
      messageSend: "off",
    });
  });

  test("accepts only explicit shadow and cutover values", () => {
    expect(readLocalFirstFeatureFlags({
      VITE_LOCAL_FIRST_V2_ENABLED: "1",
      VITE_LOCAL_FIRST_BUCKETS_MODE: "shadow",
      VITE_LOCAL_FIRST_COMMENTS_MODE: "cutover",
      VITE_LOCAL_FIRST_SMALL_VIEWS_MODE: "true",
      VITE_LOCAL_FIRST_MESSAGE_SEND_MODE: "CUTOVER",
    })).toEqual({
      buckets: "shadow",
      comments: "cutover",
      smallViews: "off",
      messageSend: "off",
    });
  });
});
