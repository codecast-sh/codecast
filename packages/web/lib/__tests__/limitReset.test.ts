import { describe, it, expect } from "vitest";
import { parseLimitResetAt } from "../limitReset";

// 2026-08-20 14:30 America/New_York = 18:30Z
const BANNER_TS = Date.UTC(2026, 7, 20, 18, 30, 0);

describe("parseLimitResetAt", () => {
  it("resolves the named wall-clock reset in the banner's zone, after the banner", () => {
    const at = parseLimitResetAt("Session limit · resets 8:40pm (America/New_York) · progress saved", BANNER_TS);
    expect(at).toBe(Date.UTC(2026, 7, 21, 0, 40, 0)); // 20:40 NY = 00:40Z next day
  });
  it("rolls to the next day when the reset time is earlier than the banner's wall time", () => {
    const at = parseLimitResetAt("resets 9am (America/New_York)", BANNER_TS);
    expect(at).toBe(Date.UTC(2026, 7, 21, 13, 0, 0));
  });
  it("returns undefined without a parseable reset or timestamp", () => {
    expect(parseLimitResetAt("You've hit your usage limit", BANNER_TS)).toBeUndefined();
    expect(parseLimitResetAt("resets 8:40pm (America/New_York)", undefined)).toBeUndefined();
    expect(parseLimitResetAt("resets 8:40pm (Not/AZone)", BANNER_TS)).toBeUndefined();
  });
});
