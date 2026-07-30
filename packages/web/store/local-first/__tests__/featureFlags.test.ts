import { describe, expect, test } from "bun:test";
import {
  readLocalFirstFeatureFlags,
  readLocalFirstWriteFlags,
} from "../featureFlags";

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

  test("one final-mode build activates every currently supported slice", () => {
    const environment = {
      VITE_LOCAL_FIRST_V2_ENABLED: "1",
      VITE_LOCAL_FIRST_FINAL_MODE: "1",
    };
    expect(readLocalFirstFeatureFlags(environment)).toEqual({
      buckets: "cutover-lts",
      comments: "cutover-lts",
      smallViews: "off",
      messageSend: "cutover-lts",
    });
    expect(readLocalFirstWriteFlags(environment)).toEqual({
      rollbackRailEnabled: true,
      enabled: true,
    });
  });

  test("the global rollback rail disables final reads and writes together", () => {
    const environment = {
      VITE_LOCAL_FIRST_V2_ENABLED: "0",
      VITE_LOCAL_FIRST_FINAL_MODE: "1",
      VITE_LOCAL_FIRST_WRITES_ENABLED: "1",
    };
    expect(readLocalFirstFeatureFlags(environment)).toEqual({
      buckets: "off",
      comments: "off",
      smallViews: "off",
      messageSend: "off",
    });
    expect(readLocalFirstWriteFlags(environment)).toEqual({
      rollbackRailEnabled: false,
      enabled: false,
    });
  });
});
