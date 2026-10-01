import { describe, expect, test } from "bun:test";
import { NO_GOAL_WEIGHT, priority } from "./linePriority";

describe("line priority", () => {
  test("goal x severity x damped signal count", () => {
    expect(priority("p0", "urgent", 1)).toBe(32);
    expect(priority("p1", "medium", 4)).toBe(4 * 2 * 3);
    expect(priority("p3", "low", 1)).toBe(1);
  });

  test("a cause with no goal ranks below any goal at equal severity and signals", () => {
    expect(priority(null, "high", 1)).toBe(NO_GOAL_WEIGHT * 3);
    expect(priority(null, "high", 1)).toBeLessThan(priority("p3", "high", 1));
    expect(priority("unranked", "high", 1)).toBe(priority("p3", "high", 1));
  });

  test("signals are damped: doubling adds one step, 128 p3 signals tie one p0", () => {
    expect(priority("p2", "medium", 8) - priority("p2", "medium", 4)).toBe(priority("p2", "medium", 1));
    expect(priority("p3", "medium", 128)).toBe(priority("p0", "medium", 1));
  });

  test("missing or nonsense inputs read as the floor, never NaN", () => {
    expect(priority(undefined, undefined, 0)).toBe(NO_GOAL_WEIGHT);
    expect(priority("p1", "none", Number.NaN)).toBe(4);
    expect(priority("p1", "low", -3)).toBe(4);
  });
});
