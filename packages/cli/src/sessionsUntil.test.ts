import { describe, expect, test } from "bun:test";
import { parseUntilStates, settleRows, untilReached, SETTLED_STATES } from "./sessionsUntil";

// Agents waited on workers with `cast sessions <id> -w --json | tail`, which
// never returns (10 minute tool timeouts), or with sleep loops. --until exits
// once every watched session settles.
describe("parseUntilStates", () => {
  test("settled is every state but working, and is the default", () => {
    expect([...parseUntilStates(undefined)].sort()).toEqual([...SETTLED_STATES].sort());
    expect(parseUntilStates(true).has("working")).toBe(false);
    expect([...parseUntilStates("settled")].sort()).toEqual([...SETTLED_STATES].sort());
  });
  test("takes either spelling and refuses non-states", () => {
    expect([...parseUntilStates("needs-input,dormant")]).toEqual(["needs_input", "dormant"]);
    expect(() => parseUntilStates("pinned")).toThrow("--until takes settled or work states");
    expect(() => parseUntilStates("finished")).toThrow("'finished' is not one");
    expect(() => parseUntilStates(",")).toThrow("at least one");
  });
});

describe("untilReached (-w --until)", () => {
  test("stops only when every watched session is in a target state", () => {
    const settled = parseUntilStates("settled");
    expect(untilReached(settled, {}, false)).toBe(false);
    expect(untilReached(settled, { a: { state: "done" }, b: { state: "working" } }, true)).toBe(false);
    expect(untilReached(settled, { a: { state: "done" }, b: { state: "needs_input" } }, true)).toBe(true);
    // Every watched session left the set (killed, dismissed): nothing holds it open.
    expect(untilReached(settled, {}, true)).toBe(true);
  });
});

describe("settleRows", () => {
  const wanted = parseUntilStates("done,needs-input");
  test("reports each watched session once, as it reaches a wanted state", () => {
    const watched = new Set(["jx7aaaa1", "jx7bbbb1"]);
    const settled = new Set<string>();
    const first = settleRows([
      { id: "jx7aaaa1", work_state: "working", title: "A" },
      { id: "jx7bbbb1", work_state: "done", title: "B", thread_state: "Shipped the fix\nStatus: done" },
      { id: "jx7cccc1", work_state: "done", title: "not watched" },
    ], watched, settled, wanted);
    expect(first).toEqual([{ id: "jx7bbbb1", short_id: "jx7bbbb", title: "B", to: "done", thread_state: "Shipped the fix" }]);
    const again = settleRows([{ id: "jx7aaaa1", work_state: "needs_input" }, { id: "jx7bbbb1", work_state: "done" }], watched, settled, wanted);
    expect(again.map((e) => [e.short_id, e.to])).toEqual([["jx7aaaa", "needs_input"]]);
    expect(settled.size).toBe(2);
  });
  test("a killed session settles whatever its state", () => {
    const out = settleRows([{ id: "jx7aaaa1", work_state: "idle", is_killed: true }], new Set(["jx7aaaa1"]), new Set(), wanted);
    expect(out[0].to).toBe("killed");
  });
});
