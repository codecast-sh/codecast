import { describe, expect, test } from "bun:test";
import { CLAUDE_EFFORT_LEVELS, PI_EFFORT_LEVELS } from "@codecast/shared/contracts";
import { effortLevelsFor, effortPosition, stepEffortLevel } from "../effortStep";
import { ownsEffortKey } from "../../hooks/useEffortKeys";

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

describe("ownsEffortKey", () => {
  const conv = { conversationId: "conv", focusOnly: false };
  const dock = { conversationId: "dock", focusOnly: true };

  test("focus in a compose popup or dock: only that surface takes the key", () => {
    expect(ownsEffortKey({ ...dock, scope: "dock", modalOpen: true })).toBe(true);
    expect(ownsEffortKey({ ...conv, scope: "dock", modalOpen: true })).toBe(false);
    expect(ownsEffortKey({ ...conv, scope: "dock", modalOpen: false })).toBe(false);
  });

  test("focus in the conversation: the conversation takes it, a dock does not", () => {
    expect(ownsEffortKey({ ...conv, scope: null, modalOpen: false })).toBe(true);
    expect(ownsEffortKey({ ...dock, scope: null, modalOpen: false })).toBe(false);
  });

  test("a modal over the conversation keeps the key off the session behind it", () => {
    expect(ownsEffortKey({ ...conv, scope: null, modalOpen: true })).toBe(false);
  });
});
