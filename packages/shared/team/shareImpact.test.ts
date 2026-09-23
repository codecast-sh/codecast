import { describe, expect, test } from "bun:test";
import {
  describeShareSpan,
  describeTeammates,
  formatDateRange,
  formatSessionCount,
  listNames,
  shareActionLabel,
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
  });
});

describe("summarizeShareImpact", () => {
  const rows = [
    { path: "/a", session_count: 5, first_active: day("08-01"), last_active: day("09-01") },
    { path: "/b", session_count: 2, first_active: day("09-10"), last_active: day("09-20") },
  ];
  test("uses the exact summary when it answered, the row while it loads", () => {
    const partial = summarizeShareImpact(["/a", "/b"], { "/a": { count: 41, first_started_at: day("06-03"), last_started_at: day("09-22"), truncated: false } }, rows);
    expect(partial).toMatchObject({ repos: 2, sessions: 43, first: day("06-03"), last: day("09-22"), exact: false, truncated: false });
    const none = summarizeShareImpact(["/a"], undefined, rows);
    expect(none).toMatchObject({ sessions: 5, first: day("08-01"), exact: false });
    const full = summarizeShareImpact(["/a"], { "/a": { count: 1024, first_started_at: day("01-01"), last_started_at: NOW, truncated: true } }, rows);
    expect(full).toMatchObject({ sessions: 1024, truncated: true, exact: true });
  });
  test("nothing selected is zero", () => {
    expect(summarizeShareImpact([], undefined, rows)).toMatchObject({ repos: 0, sessions: 0, first: null, exact: true });
  });
});

describe("labels", () => {
  const impact = { repos: 2, sessions: 112, first: day("06-03"), last: NOW, truncated: false, exact: true };
  test("the button says what leaves", () => {
    expect(shareActionLabel(impact, true)).toBe("Share 2 repos · 112 sessions");
    expect(shareActionLabel(impact, false)).toBe("Share 2 repos from today");
    expect(shareActionLabel({ ...impact, repos: 1, sessions: 0 }, true)).toBe("Share 1 repo");
    expect(shareActionLabel({ ...impact, sessions: 1024, truncated: true }, true)).toBe("Share 2 repos · 1,024+ sessions");
    expect(shareActionLabel({ ...impact, repos: 0 }, true)).toBeNull();
  });
  test("the span line follows the switch", () => {
    expect(describeShareSpan(impact, true, NOW)).toBe("112 sessions, Jun 3 to today.");
    expect(describeShareSpan(impact, false, NOW)).toBe("Sessions from today on. The 112 sessions you already have (Jun 3 to today) stay private.");
    expect(describeShareSpan({ ...impact, sessions: 0, first: null, last: null }, true, NOW)).toBe("No sessions there yet. New ones will be visible as they happen.");
  });
  test("counts and teammates", () => {
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
