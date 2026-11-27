import { describe, expect, test } from "bun:test";
import { legacyRunsInParent, runsInParentProcess } from "./runsInParent";

describe("runsInParentProcess", () => {
  test("the stored fact decides", () => {
    expect(runsInParentProcess({ runs_in_parent: true, session_id: "0b6e2c1a-uuid" })).toBe(true);
    // A `cast spawn --subagent` worker, or a promoted child keeping its agent id.
    expect(runsInParentProcess({ runs_in_parent: false, session_id: "agent-a1b2c3d4e5" })).toBe(false);
  });

  test("a legacy row (absent, or null on a client row) answers by the old rule", () => {
    expect(runsInParentProcess({ session_id: "agent-a1b2c3d4e5" })).toBe(true);
    expect(runsInParentProcess({ runs_in_parent: null, session_id: "agent-a1b2c3d4e5" })).toBe(true);
    expect(runsInParentProcess({ session_id: "0b6e2c1a-uuid", parent_conversation_id: "p" })).toBe(false);
  });
});

describe("legacyRunsInParent", () => {
  test("a Claude Code subagent transcript", () => {
    expect(legacyRunsInParent({ session_id: "agent-a1b2c3d4e5" })).toBe(true);
    expect(legacyRunsInParent({ session_id: "agent-averify-bugs-7-9" })).toBe(false);
  });

  test("a codex child the lead launched as a program, but not one started through /cli/spawn", () => {
    const child = { session_id: "019a-thread", agent_type: "codex", parent_conversation_id: "lead" };
    expect(legacyRunsInParent({ ...child, cli_flags: "--print" })).toBe(true);
    expect(legacyRunsInParent({ ...child, headless_launch: true })).toBe(true);
    expect(legacyRunsInParent({ ...child, cli_flags: "--interactive" })).toBe(false);
    expect(legacyRunsInParent({ ...child, cli_flags: "--print", spawned_by_conversation_id: "lead" })).toBe(false);
    expect(legacyRunsInParent({ session_id: "019a-top", agent_type: "codex", cli_flags: "--print" })).toBe(false);
  });

  test("everything else has its own process", () => {
    expect(legacyRunsInParent({})).toBe(false);
    expect(legacyRunsInParent({ session_id: "0b6e2c1a-uuid", parent_conversation_id: "p" })).toBe(false);
  });
});
