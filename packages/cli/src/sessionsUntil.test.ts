import { describe, expect, test } from "bun:test";
import { parseUntilStates, untilReached, SETTLED_STATES } from "./sessionsUntil";

describe("cast sessions -w --until", () => {
  test("settled is every state but working, and is the default", () => {
    expect([...parseUntilStates(undefined)].sort()).toEqual([...SETTLED_STATES].sort());
    expect(parseUntilStates(true).has("working")).toBe(false);
    expect([...parseUntilStates("needs-input,done")].sort()).toEqual(["done", "needs_input"]);
  });

  test("an unknown state is refused rather than watched forever", () => {
    expect(() => parseUntilStates("finished")).toThrow(/unknown state/);
    expect(() => parseUntilStates(",")).toThrow(/at least one/);
  });

  test("stops only when every watched session is in a target state", () => {
    const settled = parseUntilStates("settled");
    expect(untilReached(settled, {}, false)).toBe(false);
    expect(untilReached(settled, { a: { state: "done" }, b: { state: "working" } }, true)).toBe(false);
    expect(untilReached(settled, { a: { state: "done" }, b: { state: "needs_input" } }, true)).toBe(true);
    // Every watched session left the set (killed, dismissed): nothing holds it open.
    expect(untilReached(settled, {}, true)).toBe(true);
  });
});
