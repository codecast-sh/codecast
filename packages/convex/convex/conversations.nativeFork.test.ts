import { describe, expect, test } from "bun:test";
import { nativeForkEligible } from "./conversations";

// forkFromMessage hands a fork to the daemon's native-fork branch (registry
// forkCmd, e.g. grok's `--resume <parent> --fork-session --session-id <new>`)
// only when the client's whole-context copy is the honest result: a plain
// same-agent fork at the tip, on the machine holding the parent's transcript.
describe("nativeForkEligible", () => {
  const atTip = {
    isPlainFork: true,
    daemonAgentType: "grok",
    sourceSessionId: "01a04000-4d49-70f3-88b4-316e8f48a5fb",
    atTip: true,
    cloud: false,
  };

  test("at-tip plain grok fork is eligible", () => {
    expect(nativeForkEligible(atTip)).toBe(true);
  });

  test("a mid-history fork is NOT eligible (the copy cannot be cut)", () => {
    expect(nativeForkEligible({ ...atTip, atTip: false })).toBe(false);
  });

  test("a cross-agent fork is NOT eligible", () => {
    expect(nativeForkEligible({ ...atTip, isPlainFork: false })).toBe(false);
  });

  test("a cloud fork is NOT eligible (parent transcript lives elsewhere)", () => {
    expect(nativeForkEligible({ ...atTip, cloud: true })).toBe(false);
  });

  test("a parent without a session id is NOT eligible", () => {
    expect(nativeForkEligible({ ...atTip, sourceSessionId: undefined })).toBe(false);
    expect(nativeForkEligible({ ...atTip, sourceSessionId: "" })).toBe(false);
  });

  test("clients without a forkCmd take their own paths", () => {
    expect(nativeForkEligible({ ...atTip, daemonAgentType: "claude" })).toBe(false);
    expect(nativeForkEligible({ ...atTip, daemonAgentType: "opencode" })).toBe(false);
    expect(nativeForkEligible({ ...atTip, daemonAgentType: "codex" })).toBe(false);
  });
});
