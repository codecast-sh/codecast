import { describe, expect, test } from "bun:test";
import {
  classifyClaudeResumeFatalReason,
  getInitialManagedSessionId,
  shouldMaterializeFreshClaudeSession,
  shouldStartBlankSessionAfterResumeFailure,
} from "./daemon.js";

describe("getInitialManagedSessionId", () => {
  test("uses the expected conversation session id for fresh Claude sessions", () => {
    expect(getInitialManagedSessionId("claude", "Va2f0tvqiG")).toBe("Va2f0tvqiG");
  });

  test("prefers the app-server thread id for Codex sessions", () => {
    expect(getInitialManagedSessionId("codex", "placeholder-session", "thread-123")).toBe("thread-123");
  });

  test("classifies stale Claude resume failures", () => {
    expect(classifyClaudeResumeFatalReason("No conversation found with session ID: abc")).toBe("missing_conversation");
    expect(classifyClaudeResumeFatalReason("Session not found")).toBe("session_not_found");
    expect(classifyClaudeResumeFatalReason("command not found")).toBeNull();
  });

  test("materializes a fresh Claude session instead of starting a blank fallback for stale ids", () => {
    expect(shouldMaterializeFreshClaudeSession("missing_conversation")).toBe(true);
    expect(shouldMaterializeFreshClaudeSession("session_not_found")).toBe(true);
    expect(shouldStartBlankSessionAfterResumeFailure("missing_conversation")).toBe(false);
    expect(shouldStartBlankSessionAfterResumeFailure(null)).toBe(true);
  });
});
