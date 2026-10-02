import { describe, expect, it } from "bun:test";
import { changesDayLabel, localDay } from "../changesDay";

describe("changesDayLabel", () => {
  it("formats a calendar day the same in every time zone", () => {
    expect(changesDayLabel("2026-10-02")).toBe("Fri 2 Oct");
    expect(changesDayLabel("2026-01-01")).toBe("Thu 1 Jan");
    expect(changesDayLabel("2024-02-29")).toBe("Thu 29 Feb");
  });

  it("refuses what is not a real day", () => {
    expect(changesDayLabel("2026-02-30")).toBeNull();
    expect(changesDayLabel("2026-13-01")).toBeNull();
    expect(changesDayLabel("2026-10-2")).toBeNull();
    expect(changesDayLabel("")).toBeNull();
    expect(changesDayLabel(null)).toBeNull();
  });
});

describe("localDay", () => {
  it("names the viewer's local day and steps across month and year ends", () => {
    const noon = new Date(2026, 0, 1, 12).getTime();
    expect(localDay(0, noon)).toBe("2026-01-01");
    expect(localDay(-1, noon)).toBe("2025-12-31");
    expect(localDay(31, noon)).toBe("2026-02-01");
  });
});
