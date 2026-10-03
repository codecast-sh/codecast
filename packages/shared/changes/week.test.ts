import { describe, expect, test } from "bun:test";
import { isoWeekOf, ledgerLabel, releaseLedger, topWeekStories, weekAreaTotals, weekDates, weekMonday, weekStats } from "./week";

describe("ISO weeks", () => {
  test("a day's week, a week's Monday and its seven days, across year edges", () => {
    expect(isoWeekOf("2026-10-02")).toBe("2026-W40");
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
    expect(weekMonday("2026-W40")).toBe("2026-09-28");
    expect(weekMonday("2026-W53")).toBe("2026-12-28");
    expect(weekMonday("2025-W53")).toBeNull();
    expect(weekMonday("2026-W00")).toBeNull();
    expect(weekMonday("2026-10-02")).toBeNull();
    expect(weekDates("2026-W40")).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(weekDates("2026-W01")![0]).toBe("2025-12-29");
    expect(weekDates("junk")).toBeNull();
  });
});

describe("release ledger", () => {
  const r = (surface: string, version: string | undefined, sha: string, at: number) => ({ surface, version, sha, at });

  test("one line per surface, first to last, counted once per ship, busiest first", () => {
    const ledger = releaseLedger([
      r("cli", "1.1.163", "c7", 700),
      r("cli", "1.1.157", "c1", 100),
      r("desktop", "1.1.123", "d1", 650),
      r("cli", "1.1.160", "c4", 400),
      r("cli", "1.1.160", "c4", 400),
      r("backend", undefined, "3250f11aa", 800),
    ]);
    expect(ledger.map(ledgerLabel)).toEqual([
      "cli 1.1.157 to 1.1.163, 3 releases",
      "backend 3250f11, 1 release",
      "desktop 1.1.123, 1 release",
    ]);
    expect(ledger[0]).toMatchObject({ count: 3, at: 700 });
  });

  test("a week with no ships has no ledger", () => {
    expect(releaseLedger([])).toEqual([]);
  });
});

describe("area totals, ranking and stats", () => {
  const s = (story_key: string, area: string, importance: number, lines: number, area_counts: Record<string, number>) =>
    ({ story_key, area, importance, insertions: lines, deletions: 0, area_counts });

  test("areas count the stories they lead and every file touch, busiest first", () => {
    expect(weekAreaTotals([s("a", "web", 3, 10, { web: 5, shared: 1 }), s("b", "cli", 2, 10, { cli: 2 }), s("c", "web", 1, 1, { web: 1 })])).toEqual([
      { area: "web", stories: 2, files: 6 },
      { area: "cli", stories: 1, files: 2 },
      { area: "shared", stories: 0, files: 1 },
    ]);
  });

  test("the heaviest five rank by importance, then lines, then key", () => {
    const stories = [s("e", "web", 2, 900, {}), s("a", "web", 4, 10, {}), s("b", "web", 4, 50, {}), s("c", "cli", 1, 5000, {}), s("d", "cli", 2, 900, {}), s("f", "cli", 3, 1, {})];
    expect(topWeekStories(stories).map((x) => x.story_key)).toEqual(["b", "a", "f", "d", "e"]);
    expect(topWeekStories(stories, 2).map((x) => x.story_key)).toEqual(["b", "a"]);
  });

  test("days sum, people count once across the week, missing days count nothing", () => {
    const day = { commits: 4, stories: 2, releases: 1, sessions: 2, private_sessions: 1 };
    expect(weekStats([day, null, { ...day, commits: 6 }], ["Ana", "Ben", "Ana"], 3)).toEqual({
      commits: 10, stories: 4, releases: 3, people: 2, sessions: 4, private_sessions: 2,
    });
  });
});
