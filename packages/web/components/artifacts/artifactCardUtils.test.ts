import { describe, expect, it, test } from "bun:test";
import { groupByDay, relativeTime, sortPages, withEditParam } from "./artifactCardUtils";

describe("withEditParam", () => {
  it("inserts ?edit=1 before the owner-key fragment", () => {
    expect(withEditParam("https://codecast.sh/a/report#o=abc123")).toBe(
      "https://codecast.sh/a/report?edit=1#o=abc123",
    );
  });

  it("appends ?edit=1 when there is no fragment", () => {
    expect(withEditParam("https://codecast.sh/a/report")).toBe(
      "https://codecast.sh/a/report?edit=1",
    );
  });
});

describe("relativeTime", () => {
  it("returns null for missing timestamps", () => {
    expect(relativeTime(null)).toBeNull();
    expect(relativeTime(undefined)).toBeNull();
  });

  it("buckets ages coarsely", () => {
    const now = Date.now();
    expect(relativeTime(now - 10_000)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000)).toBe("2d ago");
  });
});

describe("gallery order and timeline days", () => {
  const H = 3_600_000;
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  const p = (title: string, updated: number, created: number, views: number) =>
    ({ title, slug: title, updated_at: now - updated * H, created_at: now - created * H, views });
  const rows = [p("b", 1, 50, 3), p("a", 30, 30, 9), p("c", 2, 2, 9)];

  test("sorts by each key", () => {
    expect(sortPages(rows, "updated").map((r) => r.title)).toEqual(["b", "c", "a"]);
    expect(sortPages(rows, "published").map((r) => r.title)).toEqual(["c", "a", "b"]);
    expect(sortPages(rows, "views").map((r) => r.title)).toEqual(["c", "a", "b"]);
    expect(sortPages(rows, "title").map((r) => r.title)).toEqual(["a", "b", "c"]);
  });

  test("groups by the calendar day of the sort's moment, newest day first", () => {
    const days = groupByDay(rows, "updated", now);
    expect(days.map((d) => [d.label, d.rows.map((r) => r.title)])).toEqual([
      ["Today", ["b", "c"]],
      ["Yesterday", ["a"]],
    ]);
    expect(groupByDay(rows, "published", now).map((d) => d.label)).toEqual(["Today", "Yesterday", "Saturday"]);
  });
});
