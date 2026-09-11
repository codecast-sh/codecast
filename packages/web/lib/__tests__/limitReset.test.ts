import { describe, it, expect } from "vitest";
import { formatResetLocal, limitResetAsPrinted, limitWindowLabel, parseLimitResetAt } from "../limitReset";

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

describe("limitWindowLabel", () => {
  it("names the window from the raw banner or the shaped card message", () => {
    expect(limitWindowLabel("You've hit your weekly limit · resets 7am (UTC)")).toBe("Weekly limit");
    expect(limitWindowLabel("Weekly limit · resets 7am (UTC)")).toBe("Weekly limit");
    expect(limitWindowLabel("Session limit · resets 11:30pm (America/New_York)")).toBe("Session limit");
    expect(limitWindowLabel("You've reached your Fable limit")).toBe("Fable limit");
  });
  it("falls back to the generic label when the banner names no window", () => {
    expect(limitWindowLabel("You've hit your usage limit.")).toBe("Usage limit");
    expect(limitWindowLabel("Claude usage limit reached")).toBe("Usage limit");
  });
});

describe("limitResetAsPrinted", () => {
  it("keeps the provider's clock and zone", () => {
    expect(limitResetAsPrinted("Weekly limit · resets 7am (UTC)")).toBe("7am UTC");
    expect(limitResetAsPrinted("resets 8:40 pm (America/New_York) · progress saved")).toBe("8:40pm America/New_York");
    expect(limitResetAsPrinted("You've hit your usage limit.")).toBeUndefined();
  });
});

describe("formatResetLocal", () => {
  // 2026-08-20 14:30 America/New_York (18:30Z) is "now" for every case.
  it("says only the time for a reset later today", () => {
    expect(formatResetLocal(Date.UTC(2026, 7, 21, 0, 40, 0), BANNER_TS, "America/New_York")).toBe("8:40 PM");
  });
  it("says tomorrow for a reset on the next calendar day", () => {
    expect(formatResetLocal(Date.UTC(2026, 7, 21, 13, 0, 0), BANNER_TS, "America/New_York")).toBe("tomorrow 9:00 AM");
  });
  it("names the weekday further out", () => {
    expect(formatResetLocal(Date.UTC(2026, 7, 24, 13, 0, 0), BANNER_TS, "America/New_York")).toBe("Mon 9:00 AM");
  });
});
