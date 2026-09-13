import { describe, expect, test } from "bun:test";
import { planForkFanout } from "./forkFanout";

describe("planForkFanout", () => {
  test("two or more directions: this thread takes the first, the rest become branches", () => {
    expect(planForkFanout(["A", "B", "C"])).toEqual({ parentDirection: "A", branchDirections: ["B", "C"] });
  });

  test("one direction is a spin-off branch; this thread keeps its own work", () => {
    expect(planForkFanout(["A"])).toEqual({ branchDirections: ["A"] });
  });

  test("no directions plans no branches", () => {
    expect(planForkFanout([])).toEqual({ branchDirections: [] });
  });

  test("--all-branches keeps every direction off this thread", () => {
    expect(planForkFanout(["A", "B"], { allBranches: true })).toEqual({ branchDirections: ["A", "B"] });
  });
});
