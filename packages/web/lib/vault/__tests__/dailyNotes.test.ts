import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DAILY_SETTINGS,
  adjacentDailyNote,
  dailyNotePath,
  expandTemplate,
  formatDate,
  shiftDays,
} from "../dailyNotes";

// A fixed local-time date so nothing here depends on the machine's clock.
const D = new Date(2026, 7, 1, 14, 5, 9); // Sat Aug 1 2026, 14:05:09

describe("formatDate", () => {
  test("formats the supported token set", () => {
    expect(formatDate(D, "YYYY-MM-DD")).toBe("2026-08-01");
    expect(formatDate(D, "DD/MM/YY")).toBe("01/08/26");
    expect(formatDate(D, "HH:mm:ss")).toBe("14:05:09");
    expect(formatDate(D, "dddd, MMMM DD")).toBe("Saturday, August 01");
    expect(formatDate(D, "ddd MMM DD")).toBe("Sat Aug 01");
  });

  test("leaves literal text alone and never re-substitutes its own output", () => {
    expect(formatDate(D, "Journal YYYY")).toBe("Journal 2026");
    // "MMMM" yields "August"; the trailing "ust" must not be reconsidered.
    expect(formatDate(D, "MMMM")).toBe("August");
    // Longest-token-first: YYYY wins over YY.
    expect(formatDate(D, "YYYY YY")).toBe("2026 26");
  });
});

describe("dailyNotePath", () => {
  test("joins folder and formatted name", () => {
    expect(dailyNotePath(D, DEFAULT_DAILY_SETTINGS)).toBe("Daily/2026-08-01.md");
  });

  test("root folder yields a bare filename", () => {
    expect(dailyNotePath(D, { ...DEFAULT_DAILY_SETTINGS, folder: "" })).toBe("2026-08-01.md");
  });

  test("honors a custom format", () => {
    expect(dailyNotePath(D, { folder: "Journal", format: "YYYY/MM/DD" })).toBe("Journal/2026/08/01.md");
  });
});

describe("shiftDays", () => {
  test("rolls over months and years", () => {
    expect(formatDate(shiftDays(D, 1), "YYYY-MM-DD")).toBe("2026-08-02");
    expect(formatDate(shiftDays(new Date(2026, 0, 1), -1), "YYYY-MM-DD")).toBe("2025-12-31");
    expect(formatDate(shiftDays(new Date(2026, 1, 28), 1), "YYYY-MM-DD")).toBe("2026-03-01");
  });
});

describe("adjacentDailyNote", () => {
  const paths = [
    "Daily/2026-07-30.md",
    "Daily/2026-07-31.md",
    "Daily/2026-08-02.md",
    "Daily/nested/2026-08-05.md", // deeper than the daily folder: not a daily note
    "Books/2026-08-03.md", // outside the folder
  ];

  test("finds the nearest existing note in each direction", () => {
    expect(adjacentDailyNote(paths, D, DEFAULT_DAILY_SETTINGS, -1)).toBe("Daily/2026-07-31.md");
    expect(adjacentDailyNote(paths, D, DEFAULT_DAILY_SETTINGS, 1)).toBe("Daily/2026-08-02.md");
  });

  test("ignores notes outside the daily folder or nested below it", () => {
    const laterDate = new Date(2026, 7, 4);
    expect(adjacentDailyNote(paths, laterDate, DEFAULT_DAILY_SETTINGS, 1)).toBeNull();
  });

  test("returns null when nothing exists on that side", () => {
    const early = new Date(2026, 6, 1);
    expect(adjacentDailyNote(paths, early, DEFAULT_DAILY_SETTINGS, -1)).toBeNull();
    expect(adjacentDailyNote([], D, DEFAULT_DAILY_SETTINGS, 1)).toBeNull();
  });

  test("a note for today itself is not its own neighbour", () => {
    const withToday = [...paths, "Daily/2026-08-01.md"];
    expect(adjacentDailyNote(withToday, D, DEFAULT_DAILY_SETTINGS, -1)).toBe("Daily/2026-07-31.md");
    expect(adjacentDailyNote(withToday, D, DEFAULT_DAILY_SETTINGS, 1)).toBe("Daily/2026-08-02.md");
  });
});

describe("expandTemplate", () => {
  test("substitutes title, date and time", () => {
    const out = expandTemplate("# {{title}}\n\nWritten {{date}} at {{time}}.", {
      title: "2026-08-01",
      date: D,
    });
    expect(out).toBe("# 2026-08-01\n\nWritten 2026-08-01 at 14:05.");
  });

  test("honors per-placeholder formats", () => {
    expect(expandTemplate("{{date:dddd}} / {{time:HH}}", { title: "x", date: D })).toBe("Saturday / 14");
  });

  test("leaves unknown placeholders intact", () => {
    expect(expandTemplate("{{title}} {{weather}}", { title: "T", date: D })).toBe("T {{weather}}");
  });

  test("a template with no placeholders is returned verbatim", () => {
    expect(expandTemplate("- [ ] plan the day\n", { title: "T", date: D })).toBe("- [ ] plan the day\n");
  });
});
