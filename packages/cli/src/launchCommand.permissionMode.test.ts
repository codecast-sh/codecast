import { describe, expect, test } from "bun:test";
import { claudePermissionFlagsFor, getPermissionFlags } from "./launchCommand.js";

// A backend switch resumes a Claude session in the mode it ran in, not the
// machine's launch default: a session moved out of bypass stays out of it.
describe("claudePermissionFlagsFor", () => {
  test("keeps a non-bypass mode and leaves bypass reachable", () => {
    expect(claudePermissionFlagsFor("default", null)).toBe("--permission-mode default --allow-dangerously-skip-permissions");
    expect(claudePermissionFlagsFor("acceptEdits", null)).toBe("--permission-mode acceptEdits --allow-dangerously-skip-permissions");
    expect(claudePermissionFlagsFor("plan", null)).toBe("--permission-mode plan --allow-dangerously-skip-permissions");
  });
  test("keeps bypass as bypass", () => {
    expect(claudePermissionFlagsFor("bypassPermissions", null)).toBe("--permission-mode bypassPermissions");
  });
  test("falls back to the machine default for an unknown or absent mode", () => {
    expect(claudePermissionFlagsFor(undefined, null)).toBe(getPermissionFlags("claude", null));
    expect(claudePermissionFlagsFor("bogus; rm -rf /", null)).toBe(getPermissionFlags("claude", null));
  });
});
