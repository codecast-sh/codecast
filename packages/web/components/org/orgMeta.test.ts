import { describe, expect, test } from "bun:test";
import { changeLine, chipLine, SEVERITY_META, standingLineOf } from "./orgMeta";
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

describe("changeLine and chipLine", () => {
  test("changeLine is total: a kind this build does not know still reads as a line", () => {
    expect(changeLine({ kind: "rename", handle: "growth" } as any)).toBe("Rename (not supported in this build)");
    expect(changeLine({} as any)).toBe("Change (not supported in this build)");
    expect(changeLine({ kind: "trust", handle: "growth", trust: "decide" })).toBe("Trust @growth to decide");
  });

  test("chipLine is the delta alone, with counts compacted", () => {
    expect(chipLine({ kind: "budget", handle: "growth", caps: { tokens_per_day: 800_000, wakes_per_day: 12 } })).toBe("wakes 12 \u00b7 tokens 800k");
    expect(chipLine({ kind: "budget", handle: "growth", caps: { tokens_per_day: 1_500_000 } })).toBe("tokens 1.5M");
    expect(chipLine({ kind: "scope", handle: "growth", add: ["Platform"] })).toBe("+ Platform");
    expect(chipLine({ kind: "move", handle: "growth", reports_to: "@infra", scope_add: ["Billing"] })).toBe("under @infra +Billing");
    expect(chipLine({ kind: "move", handle: "growth" })).toBe("move");
    expect(chipLine({ kind: "file", plan: "pl-9", project: "Growth" })).toBe("pl-9 under Growth");
    expect(chipLine({ kind: "project_meta", project: "Growth", priority: "p1", owner: "@growth" })).toBe("Growth \u00b7 p1 \u00b7 owner @growth");
    expect(chipLine({ kind: "adopt", handle: "growth", conversation: "jx7abcd" })).toBe("adopt jx7abcd");
    expect(chipLine({ kind: "projects", changes: [{ op: "create", title: "Platform" }] })).toBe("+ Platform");
  });

  test("severity is carried in shape and word: a blocker filled and tagged, a warning a ring, info no dot", () => {
    expect(SEVERITY_META.blocker).toMatchObject({ dot: "filled", tag: true, word: "blocker" });
    expect(SEVERITY_META.warn).toMatchObject({ dot: "ring", tag: false });
    expect(SEVERITY_META.info).toMatchObject({ dot: "none", tag: false });
    expect(SEVERITY_META.warn.color).not.toBe(SEVERITY_META.blocker.color);
  });
});
