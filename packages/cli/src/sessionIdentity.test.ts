import { describe, expect, test } from "bun:test";
import { chatSendOrigin, sessionIdFromEnv, workOriginStamp } from "./sessionIdentity.js";

describe("chatSendOrigin", () => {
  test.each([
    ["CLAUDE_CODE_SESSION_ID", "claude-session"],
    ["CODEX_THREAD_ID", "native-codex-thread"],
    ["CODEX_SESSION_ID", "codex-session"],
    ["CODECAST_SESSION_ID", "codecast-session"],
    ["CODECAST_MANAGED_SESSION", "managed-session"],
  ])("personifies chat sent with %s", (key, sessionId) => {
    expect(chatSendOrigin({ [key]: sessionId })).toEqual({
      origin: "agent",
      origin_session_id: sessionId,
    });
  });

  test("leaves a human shell unstamped", () => {
    expect(chatSendOrigin({})).toEqual({});
  });

  test("uses the native Codex thread before legacy wrapper identifiers", () => {
    expect(sessionIdFromEnv({
      CODEX_THREAD_ID: "current-thread",
      CODEX_SESSION_ID: "old-thread",
      CODECAST_SESSION_ID: "wrapper-thread",
      CODECAST_MANAGED_SESSION: "managed-thread",
    })).toBe("current-thread");
  });
});

describe("workOriginStamp", () => {
  test("a detected session is agent work bound to that conversation, even with --human", () => {
    expect(workOriginStamp({ sessionId: "sess-1", stdoutIsTTY: true, human: true })).toEqual({
      source: "agent",
      conversation_id: "sess-1",
    });
  });

  test("a person at a terminal is human", () => {
    expect(workOriginStamp({ sessionId: null, stdoutIsTTY: true })).toEqual({ source: "human" });
  });

  test("--human is positive evidence without a TTY", () => {
    expect(workOriginStamp({ sessionId: null, stdoutIsTTY: false, human: true })).toEqual({ source: "human" });
  });

  test("a missed session with piped output stays off the shelf", () => {
    expect(workOriginStamp({ sessionId: null, stdoutIsTTY: false })).toEqual({ source: "agent" });
    expect(workOriginStamp({ sessionId: null })).toEqual({ source: "agent" });
  });
});
