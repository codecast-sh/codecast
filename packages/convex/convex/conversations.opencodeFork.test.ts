import { describe, expect, test } from "bun:test";
import { opencodeApiForkEligible } from "./conversations";

// forkFromMessage passes the parent's real ses_ id down to the daemon ONLY when the
// fork can actually resolve to a real, correctly-scoped opencode session:
//  - a same-agent opencode fork of a parent that already has a resolved ses_ id, and
//  - either it's an at-tip fork (a full fork, no messageID, matches the copy) OR it's a
//    partial fork whose truncation messageID (the message after the fork point) resolved.
// A partial fork that can't resolve that messageID must NOT go through the API — that
// would fork the parent's FULL history while the copy shows a truncated one.
describe("opencodeApiForkEligible", () => {
  const atTip = {
    isPlainFork: true,
    daemonAgentType: "opencode",
    sourceAgentType: "opencode",
    sourceSessionId: "ses_08fca822fffeeAlucC44xJ71Kl",
    atTip: true,
  };
  const partial = { ...atTip, atTip: false, forkMessageId: "msg_f70610ce20011hSq6ZHaX9zMEI" };

  test("at-tip opencode fork (full, no messageID) is eligible", () => {
    expect(opencodeApiForkEligible(atTip)).toBe(true);
  });

  test("partial opencode fork WITH a resolved truncation messageID is eligible", () => {
    expect(opencodeApiForkEligible(partial)).toBe(true);
  });

  test("partial opencode fork that could NOT resolve a messageID is NOT eligible (honest fallback)", () => {
    expect(opencodeApiForkEligible({ ...partial, forkMessageId: undefined })).toBe(false);
  });

  test("cross-agent switch (not a plain fork) is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...atTip, isPlainFork: false })).toBe(false);
  });

  test("non-opencode target agent is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...atTip, daemonAgentType: "claude" })).toBe(false);
  });

  test("non-opencode source agent is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...atTip, sourceAgentType: "codex" })).toBe(false);
  });

  test("parent whose id is still a synthetic forked-<id> is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...atTip, sourceSessionId: "forked-ses_x-abc" })).toBe(false);
  });

  test("missing parent session id is NOT eligible", () => {
    expect(opencodeApiForkEligible({ ...atTip, sourceSessionId: undefined })).toBe(false);
  });
});
