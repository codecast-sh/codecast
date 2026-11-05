import { describe, expect, test } from "bun:test";
import { unreachableTerminalHoldReason, unreachableTerminalOf } from "./deliveryHold";

describe("unreachable terminal hold reason", () => {
  test("names the terminal and reads back", () => {
    const reason = unreachableTerminalHoldReason("Ghostty");
    expect(reason).toBe("runs in Ghostty, which Codecast can't type into");
    expect(unreachableTerminalOf(reason)).toBe("Ghostty");
  });

  test("any other hold names no terminal", () => {
    for (const reason of ["waiting for a human answer in the terminal", "waiting for terminal input confirmation", "", undefined, null]) {
      expect(unreachableTerminalOf(reason)).toBeNull();
    }
  });
});
