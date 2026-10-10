import { describe, expect, spyOn, test } from "bun:test";
import { sameNameSuffixes } from "../sameNameSuffix";

const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

// Each row's column reads the same ("Mon"), so namesakes need their suffix.
const sameColumn = () => "Mon";

describe("sameNameSuffixes", () => {
  test("stops formatting once a distinguishing form is found", () => {
    const clock = spyOn(Date.prototype, "toLocaleTimeString");
    const rows = [{ _id: "a", title: "Same", started_at: NOW - DAY }, { _id: "b", title: "Same", started_at: NOW - 2 * DAY }];
    const result = sameNameSuffixes(rows, (r) => r.title, NOW, () => "same column");
    const calls = clock.mock.calls.length;
    clock.mockRestore();
    expect(result.get("a")).not.toBe(result.get("b"));
    expect(calls).toBe(0);
  });
  test("does not format dates for unique titles", () => {
    let formats = 0;
    const rows = [{ _id: "a", title: "One" }, { _id: "b", title: "Two" }];
    expect(sameNameSuffixes(rows, (r) => r.title, NOW, () => { formats++; return "Mon"; }).size).toBe(0);
    expect(formats).toBe(0);
  });
  test("namesakes whose time columns differ need no suffix", () => {
    const rows = [
      { _id: "a", title: "Decline dinner invitation", updated_at: NOW - 60 * 60_000 },
      { _id: "b", title: "Decline dinner invitation", updated_at: NOW - DAY },
    ];
    expect(sameNameSuffixes(rows, (r) => r.title, NOW).size).toBe(0);
  });

  test("a suffix never repeats the column it sits beside", () => {
    const rows = [
      { _id: "a", title: "Plan", started_at: NOW - 60_000, updated_at: NOW - 3 * 60 * 60_000 },
      { _id: "b", title: "Plan", started_at: NOW - 120_000, updated_at: NOW - 3 * 60 * 60_000 },
    ];
    const out = sameNameSuffixes(rows, (r) => r.title, NOW);
    expect(out.get("a")).not.toBe(out.get("b"));
    expect(out.get("a")).not.toBe(new Date(NOW - 3 * 60 * 60_000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  });

  test("only rows sharing a title get a suffix: the day each began, or the time on the same day", () => {
    const rows = [
      { _id: "a", title: "Decline dinner invitation", started_at: NOW - DAY },
      { _id: "b", title: "decline dinner invitation ", started_at: NOW - 2 * DAY },
      { _id: "c", title: "Water the plants", started_at: NOW },
      { _id: "d", title: "Plan the week", started_at: NOW - 60_000 },
      { _id: "e", title: "Plan the week", started_at: NOW - 120_000 },
    ];
    const out = sameNameSuffixes(rows, (r) => r.title, NOW, sameColumn);
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
    const out = sameNameSuffixes(rows, (r) => r.title, NOW, sameColumn);
    expect(out.get("t")).toMatch(/\d:\d\d/);
    expect(out.get("y")).toBe("Yesterday");
    expect(out.get("w")).toBe(new Date(NOW - 3 * DAY).toLocaleDateString([], { weekday: "short" }));
    expect(out.get("o")).toBe(new Date(NOW - 20 * DAY).toLocaleDateString([], { month: "short", day: "numeric" }));
  });
});
