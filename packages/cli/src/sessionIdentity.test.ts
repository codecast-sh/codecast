import { describe, expect, test } from "bun:test";
import { chatSendOrigin } from "./sessionIdentity.js";

describe("chatSendOrigin", () => {
  test.each([
    ["CLAUDE_CODE_SESSION_ID", "claude-session"],
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
});
