import { describe, expect, test } from "bun:test";
import { standingLineOf } from "./orgMeta";
import { THREAD_STATE_STATUS_META } from "../../lib/threadState";

// The founder reads a lead's colour from the lead's own declaration, not from
// a tally of its hands (org-roles-standing.md, the 07:00 scene). One reading
// for the role card, the anchor card and the panels.
describe("standingLineOf", () => {
  test("a declared status names the colour and keeps the pinned line", () => {
    const line = standingLineOf({ state: "working", state_line: "Rotating the prod key", state_status: "blocked" })!;
    expect(line.color).toBe(THREAD_STATE_STATUS_META.blocked.color);
    expect(line.label).toBe("needs input");
    expect(line.text).toBe("Rotating the prod key");
  });

  test("with nothing declared the observed work state stands in", () => {
    const line = standingLineOf({ state: "dormant", state_line: null, state_status: null })!;
    expect(line.color).toBe("var(--sol-blue)");
    expect(line.label).toBe("dormant");
    expect(line.text).toBeNull();
  });

  test("an unknown status word falls through; a bare line is 'pinned'; nothing is null", () => {
    expect(standingLineOf({ state_status: "purple", state_line: "Hello" })!.label).toBe("pinned");
    expect(standingLineOf({ state_line: "  " })).toBeNull();
    expect(standingLineOf(null)).toBeNull();
    expect(standingLineOf(undefined)).toBeNull();
  });

  test("every status in the shared table carries an inline colour", () => {
    for (const m of Object.values(THREAD_STATE_STATUS_META)) expect(m.color).toMatch(/^var\(--sol-/);
  });
});
