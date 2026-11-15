import { describe, expect, test } from "bun:test";
import { CLAUDE_EFFORT_LEVELS, PI_EFFORT_LEVELS } from "@codecast/shared/contracts";
import { effortLevelsFor, effortPosition, stepEffortLevel } from "../effortStep";

describe("stepEffortLevel", () => {
  const levels = CLAUDE_EFFORT_LEVELS;

  test("moves one level up and down", () => {
    expect(stepEffortLevel(levels, "medium", 1)).toBe("high");
    expect(stepEffortLevel(levels, "medium", -1)).toBe("low");
  });

  test("stops at either end of the scale", () => {
    expect(stepEffortLevel(levels, "max", 1)).toBeNull();
    expect(stepEffortLevel(levels, "low", -1)).toBeNull();
  });

  test("an unpinned session's first step pins the level its position names", () => {
    expect(stepEffortLevel(levels, null, 1)).toBe("high");
    expect(stepEffortLevel(levels, undefined, -1)).toBe("high");
  });

  test("a scale without high starts from its middle", () => {
    expect(effortPosition(["a", "b", "c"], null)).toBe(1);
    expect(effortPosition(PI_EFFORT_LEVELS, null)).toBe(PI_EFFORT_LEVELS.indexOf("high"));
  });
});

describe("effortLevelsFor", () => {
  test("a client with effort levels steps through them", () => {
    expect(effortLevelsFor("claude_code", null, null, true)).toEqual(CLAUDE_EFFORT_LEVELS);
  });

  test("a client without levels has nothing to step", () => {
    expect(effortLevelsFor("cursor", null, null, true)).toEqual([]);
  });
});
