import { describe, expect, test } from "bun:test";
import { isSupersededAppServerSession, mapCodexAppServerThreadStatusToAgentStatus } from "./daemon.js";

describe("app-server status ownership after switching agents", () => {
  const conv = "conversation";
  const live = new Map([[conv, "codex-thread"]]);
  const persisted = new Map([[conv, { threadId: "codex-thread", updatedAt: 1 }]]);

  test("the old Claude session cannot overwrite the active Codex status", () => {
    expect(isSupersededAppServerSession("claude-session", conv, live, persisted)).toBe(true);
    expect(isSupersededAppServerSession("codex-thread", conv, live, persisted)).toBe(false);
  });

  test("ownership survives daemon restart before rehydration completes", () => {
    expect(isSupersededAppServerSession("claude-session", conv, new Map(), persisted)).toBe(true);
    expect(isSupersededAppServerSession("codex-thread", conv, new Map(), persisted)).toBe(false);
  });

  test("ordinary sessions and a switch away from app-server retain status updates", () => {
    expect(isSupersededAppServerSession("other-session", "other-conv", live, persisted)).toBe(false);
    expect(isSupersededAppServerSession("claude-session", conv, new Map(), new Map())).toBe(false);
  });

  test("a new live thread outranks an older persisted registration", () => {
    const replacement = new Map([[conv, "new-thread"]]);
    expect(isSupersededAppServerSession("codex-thread", conv, replacement, persisted)).toBe(true);
    expect(isSupersededAppServerSession("new-thread", conv, replacement, persisted)).toBe(false);
  });
});

describe("mapCodexAppServerThreadStatusToAgentStatus", () => {
  test("maps idle threads to idle", () => {
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "idle" })).toBe("idle");
  });

  test("maps active threads without blockers to working", () => {
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: [] }),
    ).toBe("working");
  });

  test("maps approval and user-input blockers to permission_blocked", () => {
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: ["waitingOnApproval"] }),
    ).toBe("permission_blocked");
    expect(
      mapCodexAppServerThreadStatusToAgentStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }),
    ).toBe("permission_blocked");
  });

  test("maps system errors to stopped and ignores non-loaded states", () => {
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "systemError" })).toBe("stopped");
    expect(mapCodexAppServerThreadStatusToAgentStatus({ type: "notLoaded" })).toBeNull();
  });
});
