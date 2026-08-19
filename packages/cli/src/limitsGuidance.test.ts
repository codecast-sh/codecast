import { describe, expect, test } from "bun:test";
import { shouldAutoEnableLimitsGuidance, LIMITS_AUTO_ENABLE_MIN_PROFILES } from "./limitsGuidance";

describe("shouldAutoEnableLimitsGuidance", () => {
  test("turns on once a second account is saved, only from the undecided state", () => {
    expect(LIMITS_AUTO_ENABLE_MIN_PROFILES).toBe(2);
    expect(shouldAutoEnableLimitsGuidance({}, 1)).toBe(false);
    expect(shouldAutoEnableLimitsGuidance({}, 2)).toBe(true);
    expect(shouldAutoEnableLimitsGuidance(null, 12)).toBe(true);
    // An explicit off (Settings toggle / --disable) is respected forever; an
    // explicit on has nothing to do.
    expect(shouldAutoEnableLimitsGuidance({ limits_enabled: false }, 12)).toBe(false);
    expect(shouldAutoEnableLimitsGuidance({ limits_enabled: true }, 12)).toBe(false);
  });
});
