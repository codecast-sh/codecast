import { describe, expect, test } from "bun:test";
import { sameNameSuffixes } from "../sameNameSuffix";

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("sameNameSuffixes", () => {
  test("only rows sharing a title get a suffix: the day each began, or the time on the same day", () => {
    const rows = [
      { _id: "a", title: "Decline dinner invitation", started_at: NOW - DAY },
      { _id: "b", title: "decline dinner invitation ", started_at: NOW - 2 * DAY },
      { _id: "c", title: "Water the plants", started_at: NOW },
      { _id: "d", title: "Plan the week", started_at: NOW - 60_000 },
      { _id: "e", title: "Plan the week", started_at: NOW - 120_000 },
    ];
    const out = sameNameSuffixes(rows, (r) => r.title, NOW);
    expect(out.has("c")).toBe(false);
    expect(out.get("a")).not.toBe(out.get("b"));
    expect(out.get("d")).toMatch(/\d:\d\d/);
    expect(out.get("d")).not.toBe(out.get("e"));
  });

  test("today reads as a clock time, yesterday as Yesterday, this week as a weekday", () => {
    const rows = [
      { _id: "t", title: "Weekend plan", started_at: NOW - 2 * 60_000 },
      { _id: "y", title: "Weekend plan", started_at: NOW - DAY },
      { _id: "w", title: "Weekend plan", started_at: NOW - 3 * DAY },
      { _id: "o", title: "Weekend plan", started_at: NOW - 20 * DAY },
    ];
    const out = sameNameSuffixes(rows, (r) => r.title, NOW);
    expect(out.get("t")).toMatch(/\d:\d\d/);
    expect(out.get("y")).toBe("Yesterday");
    expect(out.get("w")).toBe(new Date(NOW - 3 * DAY).toLocaleDateString([], { weekday: "short" }));
    expect(out.get("o")).toBe(new Date(NOW - 20 * DAY).toLocaleDateString([], { month: "short", day: "numeric" }));
  });
});
