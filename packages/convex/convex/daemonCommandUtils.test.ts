import { describe, expect, test } from "bun:test";
import { hasRecentPendingDaemonCommand } from "./daemonCommandUtils";

describe("hasRecentPendingDaemonCommand", () => {
  test("matches recent pending commands for the same conversation", () => {
    const now = 1_000_000;
    expect(hasRecentPendingDaemonCommand([
      {
        command: "resume_session",
        args: JSON.stringify({ conversation_id: "jx123" }),
        _creationTime: now - 5_000,
      },
    ], {
      conversationId: "jx123",
      command: "resume_session",
      now,
    })).toBe(true);
  });

  test("ignores stale or different conversation commands", () => {
    const now = 1_000_000;
    expect(hasRecentPendingDaemonCommand([
      {
        command: "resume_session",
        args: JSON.stringify({ conversation_id: "jx123" }),
        _creationTime: now - 60_000,
      },
      {
        command: "resume_session",
        args: JSON.stringify({ conversation_id: "jx999" }),
        _creationTime: now - 5_000,
      },
    ], {
      conversationId: "jx123",
      command: "resume_session",
      now,
    })).toBe(false);
  });
});
