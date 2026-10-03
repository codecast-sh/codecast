import { describe, expect, test } from "bun:test";
import { changesHref, clearFilters, hasFilters, isoWeekOf, parseChangesUrl, weekDaysOf, weekMonday } from "../useChangesUrlState";

describe("ISO weeks", () => {
  test("a day's week, across year ends", () => {
    expect(isoWeekOf("2026-10-02")).toBe("2026-W40");
    expect(isoWeekOf("2026-09-28")).toBe("2026-W40");
    expect(isoWeekOf("2026-10-04")).toBe("2026-W40");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
  });

  test("a week's Monday and its seven days", () => {
    expect(weekMonday("2026-W40")).toBe("2026-09-28");
    expect(weekMonday("2025-W01")).toBe("2024-12-30");
    expect(weekMonday("nope")).toBeNull();
    expect(weekMonday("2026-W53")).toBe("2026-12-28");
    expect(weekMonday("2025-W53")).toBeNull();
    expect(weekMonday("2026-W00")).toBeNull();
    expect(weekDaysOf("2026-10-02")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  });
});

describe("the view in the URL", () => {
  test("a pasted link reads back to the same view", () => {
    const href = "/changes?repo=codecast-sh/codecast&d=2026-10-02&area=cli,web&person=u1&branches=all&risk=1&story=abc";
    const url = parseChangesUrl(new URLSearchParams(href.split("?")[1]));
    expect(url).toMatchObject({ repo: "codecast-sh/codecast", d: "2026-10-02", areas: ["cli", "web"], person: "u1", branches: "all", risk: true, story: "abc" });
    expect(changesHref(url)).toBe(href);
  });

  test("defaults stay out of the URL and junk is dropped", () => {
    expect(changesHref(parseChangesUrl(new URLSearchParams("d=2026-13&branches=main&risk=0&area=")))).toBe("/changes");
    expect(parseChangesUrl(new URLSearchParams("d=2026-02-31")).d).toBeUndefined();
    expect(parseChangesUrl(new URLSearchParams("d=2026-13-45")).d).toBeUndefined();
    expect(parseChangesUrl(new URLSearchParams("w=2026-W60")).w).toBeUndefined();
  });

  test("week mode keeps the day it was entered from", () => {
    const url = parseChangesUrl(new URLSearchParams("d=2026-10-01&w=2026-W40"));
    expect(url).toMatchObject({ d: "2026-10-01", w: "2026-W40" });
    expect(changesHref(url)).toBe("/changes?d=2026-10-01&w=2026-W40");
  });

  test("filters are the narrowing parts, and clearing keeps the view", () => {
    const url = parseChangesUrl(new URLSearchParams("d=2026-10-01&branches=all&area=cli&q=fix"));
    expect(hasFilters(url)).toBe(true);
    const cleared = clearFilters(url);
    expect(hasFilters(cleared)).toBe(false);
    expect(changesHref(cleared)).toBe("/changes?d=2026-10-01&branches=all");
  });
});
