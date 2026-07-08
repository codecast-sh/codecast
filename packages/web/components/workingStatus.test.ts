import { test, expect, describe } from "bun:test";
import {
  formatElapsedClock,
  shouldShowElapsed,
  deriveRunningTool,
  WORKING_ELAPSED_GRACE_MS,
} from "./workingStatus";

describe("formatElapsedClock", () => {
  test("m:ss under an hour, zero-padded seconds", () => {
    expect(formatElapsedClock(0)).toBe("0:00");
    expect(formatElapsedClock(5_000)).toBe("0:05");
    expect(formatElapsedClock(74_000)).toBe("1:14");
    expect(formatElapsedClock(134_000)).toBe("2:14");
    expect(formatElapsedClock(599_000)).toBe("9:59");
  });

  test("h:mm:ss at and past an hour, zero-padded minutes", () => {
    expect(formatElapsedClock(3_600_000)).toBe("1:00:00");
    expect(formatElapsedClock(3_725_000)).toBe("1:02:05");
    expect(formatElapsedClock(7_384_000)).toBe("2:03:04");
  });

  test("never renders negative time (clock skew floors at 0)", () => {
    expect(formatElapsedClock(-5_000)).toBe("0:00");
  });
});

describe("shouldShowElapsed", () => {
  test("hidden before the grace, shown at/after it", () => {
    const start = 1_000_000;
    expect(shouldShowElapsed(start, start)).toBe(false);
    expect(shouldShowElapsed(start, start + WORKING_ELAPSED_GRACE_MS - 1)).toBe(false);
    expect(shouldShowElapsed(start, start + WORKING_ELAPSED_GRACE_MS)).toBe(true);
    expect(shouldShowElapsed(start, start + 5 * 60_000)).toBe(true);
  });

  test("undefined start never shows (no anchor to count from)", () => {
    expect(shouldShowElapsed(undefined, 1_000_000)).toBe(false);
  });
});

describe("deriveRunningTool", () => {
  const asstWithTools = (...names: string[]) => ({
    type: "message",
    data: { role: "assistant", tool_calls: names.map((name) => ({ name })) },
  });
  const asstText = { type: "message", data: { role: "assistant", tool_calls: [] } };
  const user = { type: "message", data: { role: "user" } };
  const system = { type: "message", data: { role: "system" } };

  test("tail assistant with an unanswered tool call → that tool is running", () => {
    expect(deriveRunningTool([user, asstWithTools("Bash")])).toBe("Bash");
  });

  test("multiple tool calls in the tail message → the last one", () => {
    expect(deriveRunningTool([asstWithTools("Read", "Edit", "Bash")])).toBe("Bash");
  });

  test("tail is a user message (tool result already landed) → nothing running", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), user])).toBeUndefined();
  });

  test("tail assistant is pure text (a long generation) → nothing running", () => {
    expect(deriveRunningTool([asstText])).toBeUndefined();
  });

  test("trailing system messages are skipped, not treated as the end", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), system])).toBe("Bash");
  });

  test("non-message timeline items (dividers, etc.) are skipped", () => {
    expect(deriveRunningTool([asstWithTools("Bash"), { type: "divider", data: {} }])).toBe("Bash");
  });

  test("empty timeline → undefined", () => {
    expect(deriveRunningTool([])).toBeUndefined();
  });
});
