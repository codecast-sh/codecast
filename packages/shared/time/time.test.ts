import { describe, expect, test } from "bun:test";
import {
  describeDates,
  describeDatesFull,
  formatDateSmart,
  formatRelative,
  formatShortDate,
  relTimeShort,
  wasEdited,
} from "./index";

// A fixed clock so every expectation is deterministic: 2026-09-05 12:00 local.
const now = new Date(2026, 8, 5, 12, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("relTimeShort / formatRelative", () => {
  test("share buckets and round down", () => {
    expect(relTimeShort(now - 30_000, now)).toBe("now");
    expect(relTimeShort(now - 90_000, now)).toBe("1m");
    expect(relTimeShort(now - 5 * HOUR, now)).toBe("5h");
    expect(relTimeShort(now - 3 * DAY, now)).toBe("3d");
    expect(formatRelative(now - 30_000, now)).toBe("just now");
    expect(formatRelative(now - 3 * DAY, now)).toBe("3d ago");
  });
});

describe("formatDateSmart", () => {
  test("relative inside a week, calendar past it", () => {
    expect(formatDateSmart(now - 6 * DAY, now)).toBe("6d ago");
    expect(formatDateSmart(now - 8 * DAY, now)).toBe("Aug 28");
  });
  test("adds the year only when it differs from the current one", () => {
    const lastYear = new Date(2025, 7, 2).getTime();
    expect(formatShortDate(lastYear, now)).toBe("Aug 2, 2025");
    expect(formatShortDate(now - 8 * DAY, now)).toBe("Aug 28");
  });
});

describe("wasEdited / describeDates", () => {
  const created = now - 10 * DAY;
  test("a write inside the creation minute is not an edit", () => {
    expect(wasEdited({ created_at: created, updated_at: created })).toBe(false);
    expect(wasEdited({ created_at: created, updated_at: created + 30_000 })).toBe(false);
    expect(wasEdited({ created_at: created })).toBe(false);
  });
  test("a later write is", () => {
    expect(wasEdited({ created_at: created, updated_at: created + 2 * MIN })).toBe(true);
  });
  test("label shows creation alone until an edit lands", () => {
    expect(describeDates({ created_at: created, updated_at: created }, now)).toBe("Created Aug 26");
    expect(describeDates({ created_at: created, updated_at: now - 2 * HOUR }, now)).toBe("Created Aug 26 · Updated 2h ago");
  });
  test("full form puts each date on its own line", () => {
    const full = describeDatesFull({ created_at: created, updated_at: now - 2 * HOUR });
    const lines = full.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Created \w+, August 26, 2026/);
    expect(lines[1]).toMatch(/^Updated \w+, September 5, 2026/);
    expect(describeDatesFull({ created_at: created })).not.toContain("\n");
  });
});
