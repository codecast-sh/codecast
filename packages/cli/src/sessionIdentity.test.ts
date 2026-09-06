import { describe, expect, test } from "bun:test";
import { chatSendOrigin, sessionIdFromEnv } from "./sessionIdentity.js";

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
