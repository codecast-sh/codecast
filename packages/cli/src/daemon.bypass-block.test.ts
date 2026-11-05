import { describe, expect, test } from "bun:test";
import { classifyBypassBlock, isPhantomBypassPermissionBlock } from "./daemon.js";

describe("isPhantomBypassPermissionBlock", () => {
  test("suppresses auto-approved tool permission_blocked in bypass mode", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", "Bash: rm -rf")).toBe(true);
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", undefined)).toBe(true);
  });

  test("lets a genuine AskUserQuestion block through even in bypass mode", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", "AskUserQuestion")).toBe(false);
  });

  test("never suppresses outside bypass mode or for non-blocked statuses", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "default", "Bash")).toBe(false);
    expect(isPhantomBypassPermissionBlock("working", "bypassPermissions", undefined)).toBe(false);
  });
});

describe("classifyBypassBlock", () => {
  const SID = "07191b53";

  test("holds an AskUserQuestion block across a context-free follow-up (the bug)", () => {
    // Exact sequence that left jx7dwas showing "working/stuck" for 13 min on the web.
    const blocked = new Set<string>();

    // 1. PreToolUse AskUserQuestion: the agent is now waiting. Not a phantom.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "AskUserQuestion").suppress).toBe(false);
    expect(blocked.has(SID)).toBe(true);

    // 2. Follow-up generic Notification (no tool name) while still waiting. Pre-fix this
    //    was suppressed -> status reverted to "working" -> web fell behind. Must hold.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined).suppress).toBe(false);
    expect(blocked.has(SID)).toBe(true);

    // 3. The answer lands and the agent moves on. Block closes.
    expect(classifyBypassBlock(blocked, SID, "working", "bypassPermissions", undefined).suppress).toBe(false);
    expect(blocked.has(SID)).toBe(false);

    // 4. A genuine phantom auto-approve afterwards is suppressed again, as before.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "Bash: rm -rf").suppress).toBe(true);
  });

  test("a phantom with no preceding AskUserQuestion is still suppressed", () => {
    const blocked = new Set<string>();
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "Bash").suppress).toBe(true);
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined).suppress).toBe(true);
    expect(blocked.has(SID)).toBe(false);
  });

  test("never suppresses outside bypass mode, even mid-block", () => {
    const blocked = new Set<string>();
    classifyBypassBlock(blocked, SID, "permission_blocked", "default", "AskUserQuestion");
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "default", undefined).suppress).toBe(false);
  });

  // jx7e7zm, 2026-11-04: a privacy hook's "ask" put a confirmation dialog on screen in a
  // bypass session. The PermissionRequest and every Notification after it were rewritten
  // to "working", and the session sat on a dialog nobody was shown for 9 hours.
  test("a PermissionRequest dialog in bypass mode is real, and holds until the agent moves on", () => {
    const blocked = new Set<string>();
    const dialogs = new Set<string>();
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", "Bash: cast task comment", dialogs, true).suppress).toBe(false);
    expect(dialogs.has(SID)).toBe(true);
    // Claude Code's follow-up Notification while the dialog waits: no tool, no dialog flag.
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined, dialogs).suppress).toBe(false);
    // Answered: the dialog closes and phantoms are suppressed again.
    expect(classifyBypassBlock(blocked, SID, "working", "bypassPermissions", undefined, dialogs).suppress).toBe(false);
    expect(dialogs.has(SID)).toBe(false);
    expect(classifyBypassBlock(blocked, SID, "permission_blocked", "bypassPermissions", undefined, dialogs).suppress).toBe(true);
  });

  test("isPhantomBypassPermissionBlock never calls a dialog a phantom", () => {
    expect(isPhantomBypassPermissionBlock("permission_blocked", "bypassPermissions", "Bash: x", true)).toBe(false);
  });

  test("blocks are tracked per session", () => {
    const blocked = new Set<string>();
    classifyBypassBlock(blocked, "sessA", "permission_blocked", "bypassPermissions", "AskUserQuestion");
    // A different session's phantom is unaffected by sessA's open block.
    expect(classifyBypassBlock(blocked, "sessB", "permission_blocked", "bypassPermissions", undefined).suppress).toBe(true);
    // sessA's own follow-up is still held.
    expect(classifyBypassBlock(blocked, "sessA", "permission_blocked", "bypassPermissions", undefined).suppress).toBe(false);
  });
});
