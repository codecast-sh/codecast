import { describe, expect, test } from "bun:test";
import {
  describeMappingScope,
  describeShareSpan,
  describeTeammates,
  formatDateRange,
  formatSessionCount,
  listNames,
  shareActionLabel,
  startOfDay,
  summarizeShareImpact,
} from "./shareImpact";

const NOW = new Date("2026-09-23T12:00:00").getTime();
const day = (d: string) => new Date(`2026-${d}T10:00:00`).getTime();

describe("formatDateRange", () => {
  test("names today and collapses a single day", () => {
    expect(formatDateRange(day("06-03"), NOW, NOW)).toBe("Jun 3 to today");
    expect(formatDateRange(NOW, NOW, NOW)).toBe("today");
    expect(formatDateRange(day("09-22"), day("09-22"), NOW)).toBe("Sep 22");
    expect(formatDateRange(day("06-03"), day("09-22"), NOW)).toBe("Jun 3 to Sep 22");
    expect(formatDateRange(null, null, NOW)).toBe("");
    expect(formatDateRange(day("06-03"), NOW, NOW, true)).toBe("before Jun 3 to today");
  });
});

describe("summarizeShareImpact", () => {
  const rows = [
    { path: "/a", session_count: 5, first_active: day("08-01"), last_active: day("09-01") },
    { path: "/b", session_count: 2, first_active: day("09-10"), last_active: day("09-20") },
  ];
  test("uses the exact summary when it answered, the row while it loads", () => {
    const partial = summarizeShareImpact(["/a", "/b"], { "/a": { count: 41, first_started_at: day("06-03"), last_started_at: day("09-22"), truncated: false, older: 30, hidden: 2 } }, rows);
    expect(partial).toMatchObject({ repos: 2, sessions: 43, first: day("06-03"), last: day("09-22"), older: 30, hidden: 2, exact: false, truncated: false });
    const none = summarizeShareImpact(["/a"], undefined, rows);
    expect(none).toMatchObject({ sessions: 5, first: day("08-01"), older: 0, exact: false });
    const full = summarizeShareImpact(["/a"], { "/a": { count: 1024, first_started_at: day("01-01"), last_started_at: NOW, truncated: true } }, rows);
    expect(full).toMatchObject({ sessions: 1024, truncated: true, exact: true });
  });
  test("nothing selected is zero", () => {
    expect(summarizeShareImpact([], undefined, rows)).toMatchObject({ repos: 0, sessions: 0, first: null, exact: true });
  });
});

describe("labels", () => {
  const impact = { repos: 2, sessions: 112, first: day("06-03"), last: NOW, older: 100, olderThanDay: 100, hidden: 0, manuallyShared: 0, truncated: false, exact: true };
  test("the button says what leaves", () => {
    expect(shareActionLabel(impact, null, NOW)).toBe("Share 2 repos · 112 sessions");
    expect(shareActionLabel(impact, startOfDay(NOW), NOW)).toBe("Share 2 repos · 12 sessions since today");
    expect(shareActionLabel({ ...impact, older: 112 }, startOfDay(NOW), NOW)).toBe("Share 2 repos from today");
    expect(shareActionLabel(impact, day("09-01"), NOW)).toBe("Share 2 repos · 12 sessions since Sep 1");
    expect(shareActionLabel({ ...impact, repos: 1, sessions: 0, older: 0 }, null, NOW)).toBe("Share 1 repo");
    expect(shareActionLabel({ ...impact, sessions: 1024, truncated: true }, null, NOW)).toBe("Share 2 repos · 1,024+ sessions");
    expect(shareActionLabel({ ...impact, repos: 0 }, null, NOW)).toBeNull();
  });
  test("the span line follows the share start", () => {
    expect(describeShareSpan(impact, null, NOW)).toBe("112 sessions, Jun 3 to today.");
    expect(describeShareSpan(impact, startOfDay(NOW), NOW)).toBe("12 sessions from today on. The 100 sessions before that stay private.");
    expect(describeShareSpan({ ...impact, older: 0 }, day("09-01"), NOW)).toBe("112 sessions from Sep 1 on. Nothing older there.");
    expect(describeShareSpan({ ...impact, older: 112 }, startOfDay(NOW), NOW)).toBe("Nothing yet from today on. The 112 sessions before that stay private.");
    expect(describeShareSpan({ ...impact, hidden: 3 }, null, NOW)).toBe("112 sessions, Jun 3 to today. 3 sessions you hid by hand stay hidden.");
    expect(describeShareSpan({ ...impact, sessions: 0, first: null, last: null }, null, NOW)).toBe("No sessions there yet. New ones will be visible as they happen.");
    // A cut off scan reads newest first: the exposed count is exact, the older one a floor.
    expect(describeShareSpan({ ...impact, sessions: 1024, older: 1012, truncated: true }, startOfDay(NOW), NOW)).toBe("12 sessions from today on. The 1,012+ sessions before that stay private.");
    expect(describeShareSpan({ ...impact, sessions: 1024, truncated: true }, null, NOW)).toBe("1,024+ sessions, before Jun 3 to today.");
  });
  test("a mapping's scope on a row", () => {
    expect(describeMappingScope(null, 0, NOW)).toBe("all sessions");
    expect(describeMappingScope(startOfDay(NOW), 180, NOW)).toBe("since today · 180 sessions earlier stay private");
    expect(describeMappingScope(startOfDay(NOW), 1020, NOW, true)).toBe("since today · 1,020+ sessions earlier stay private");
    expect(describeMappingScope(day("09-01"), 0, NOW)).toBe("since Sep 1");
    expect(describeMappingScope(day("09-01"), undefined, NOW)).toBe("since Sep 1");
  });
  test("counts, teammates and names", () => {
    expect(formatSessionCount(1)).toBe("1 session");
    expect(formatSessionCount(0)).toBe("no sessions");
    expect(formatSessionCount(2048, true)).toBe("2,048+ sessions");
    expect(describeTeammates(1)).toBe("no teammates yet");
    expect(describeTeammates(2)).toBe("1 teammate");
    expect(describeTeammates(5)).toBe("4 teammates");
    expect(listNames(["a"])).toBe("a");
    expect(listNames(["a", "b"])).toBe("a and b");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
    expect(listNames(["a", "b", "c", "d"])).toBe("a, b and 2 more");
  });
});
