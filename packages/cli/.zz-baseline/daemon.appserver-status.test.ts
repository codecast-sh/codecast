import { describe, expect, test } from "bun:test";
import { currentHeartbeatSessions, isSupersededAppServerSession, mapCodexAppServerThreadStatusToAgentStatus } from "./daemon.js";

test("fleet heartbeat scans the historical cache once and observes remaps on the next pass", () => {
  const rows = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`session-${i}`, `conv-${i}`]));
  let scans = 0;
  const cache = new Proxy(rows, { ownKeys(target) { scans++; return Reflect.ownKeys(target); } });
  const sessions = Array.from({ length: 300 }, (_, i) => `session-${i}`);
  const live = new Map([["conv-1", "live-thread"]]);
  const persisted = new Map([["conv-2", { threadId: "persisted-thread", updatedAt: 1 }]]);
  rows["live-thread"] = "conv-1";
  rows["persisted-thread"] = "conv-2";
  sessions.push("live-thread", "persisted-thread");
  expect(currentHeartbeatSessions(sessions, cache, live, persisted)).toEqual(
    sessions.filter(id => id !== "session-1" && id !== "session-2"),
  );
  expect(scans).toBe(1);
  rows["replacement"] = "conv-3";
  sessions.push("replacement");
  expect(currentHeartbeatSessions(sessions, cache, live, persisted)).toEqual(
    sessions.filter(id => !["session-1", "session-2", "session-3"].includes(id)),
  );
  expect(scans).toBe(2);
});

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

  test("after a switch away from Codex, the old thread is superseded via the conversation cache", () => {
    const claudeId = "75340f90-7b40-40da-b2c1-0646ce59bfca";
    const cache = {
      "nq8wm4hwa7uky27feofh": conv,
      [claudeId]: conv,
    };
    expect(isSupersededAppServerSession("nq8wm4hwa7uky27feofh", conv, new Map(), new Map(), cache)).toBe(true);
    expect(isSupersededAppServerSession(claudeId, conv, new Map(), new Map(), cache)).toBe(false);
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
