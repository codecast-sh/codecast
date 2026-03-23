import { describe, expect, test } from "bun:test";
import { getInitialManagedSessionId } from "./daemon.js";

describe("getInitialManagedSessionId", () => {
  test("uses the expected conversation session id for fresh Claude sessions", () => {
    expect(getInitialManagedSessionId("claude", "Va2f0tvqiG")).toBe("Va2f0tvqiG");
  });

  test("prefers the app-server thread id for Codex sessions", () => {
    expect(getInitialManagedSessionId("codex", "placeholder-session", "thread-123")).toBe("thread-123");
  });
});
