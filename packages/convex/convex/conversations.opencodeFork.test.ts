import { describe, expect, test } from "bun:test";
import { opencodeApiForkEligible } from "./conversations";

// forkFromMessage passes the parent's real ses_ id down to the daemon ONLY when the
// fork can actually resolve to a real opencode session — a same-agent opencode fork of
// a parent that already has a resolved ses_ id. Everything else (cross-agent switch,
// non-opencode source, an unresolved synthetic parent id) must NOT emit the fork_api
// hint, so the daemon never tries to fork a session that can't be forked.
describe("opencodeApiForkEligible", () => {
  const base = {
    isPlainFork: true,
    daemonAgentType: "opencode",
    sourceAgentType: "opencode",
    sourceSessionId: "ses_08fca822fffeeAlucC44xJ71Kl",
  };

  test("same-agent opencode fork of a resolved ses_ parent is eligible", () => {
    expect(opencodeApiForkEligible(base)).toBe(true);
  });

  test("cross-agent switch (not a plain fork) is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...base, isPlainFork: false })).toBe(false);
  });

  test("non-opencode target agent is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...base, daemonAgentType: "claude" })).toBe(false);
  });

  test("non-opencode source agent is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...base, sourceAgentType: "codex" })).toBe(false);
  });

  test("parent whose id is still a synthetic forked-<id> is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...base, sourceSessionId: "forked-ses_x-abc" })).toBe(false);
  });

  test("missing parent session id is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...base, sourceSessionId: undefined })).toBe(false);
  });
});
