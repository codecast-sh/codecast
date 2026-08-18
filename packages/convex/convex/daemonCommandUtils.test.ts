import { describe, expect, test } from "bun:test";
import { hasRecentPendingDaemonCommand, resumeConversationSession } from "./daemonCommandUtils";
import { makeFakeDb } from "./testDb";

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

// The gentle resume shared by users.resumeSession, dispatch.resumeSession and
// convCommand("resumeSession"). Regression for the 2026-08-18 "Unauthorized"
// on an owned session: users.resumeSession admitted only the runner, so the
// second-party owner (a Mr-Bot-run session assigned to a human) could not
// resume from their own inbox while restart/kill already let them.
describe("resumeConversationSession", () => {
  const RUNNER = "users_runner" as any;
  const OWNER = "users_owner" as any;
  const STRANGER = "users_stranger" as any;
  const conv = {
    _id: "conversations_1", user_id: RUNNER, owner_user_id: OWNER,
    session_id: "s1", message_count: 5, project_path: "/p", agent_type: "claude_code",
  };
  const ctxWith = (tables: Record<string, any[]>) => ({ db: makeFakeDb(tables) }) as any;

  test("the second-party owner may resume, and the command is addressed to the runner", async () => {
    const ctx = ctxWith({ conversations: [conv], daemon_commands: [], pending_messages: [] });
    const got = await resumeConversationSession(ctx, OWNER, "conversations_1" as any);
    expect("command_id" in got).toBe(true);
    const cmd = ctx.db._inserted.find((r: any) => r.table === "daemon_commands");
    expect(cmd.doc.command).toBe("resume_session");
    expect(cmd.doc.user_id).toBe(RUNNER);
  });

  test("the runner may resume", async () => {
    const ctx = ctxWith({ conversations: [conv], daemon_commands: [], pending_messages: [] });
    const got = await resumeConversationSession(ctx, RUNNER, "conversations_1" as any);
    expect("command_id" in got).toBe(true);
  });

  test("anyone else is refused", async () => {
    const ctx = ctxWith({ conversations: [conv], daemon_commands: [], pending_messages: [] });
    await expect(resumeConversationSession(ctx, STRANGER, "conversations_1" as any)).rejects.toThrow("Not authorized");
  });

  test("a missing row reports not found (the web escalates that to restore)", async () => {
    const ctx = ctxWith({ conversations: [], daemon_commands: [], pending_messages: [] });
    await expect(resumeConversationSession(ctx, OWNER, "conversations_gone" as any)).rejects.toThrow("Conversation not found");
  });

  test("a fresh 0-message session is a no-op", async () => {
    const ctx = ctxWith({ conversations: [{ ...conv, message_count: 0 }], daemon_commands: [], pending_messages: [] });
    const got = await resumeConversationSession(ctx, OWNER, "conversations_1" as any);
    expect(got).toEqual({ skipped: true, reason: "fresh_session_no_messages" });
    expect(ctx.db._inserted.length).toBe(0);
  });
});
