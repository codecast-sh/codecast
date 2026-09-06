import { describe, expect, test } from "bun:test";
import { enqueueHibernateSession, hasRecentPendingDaemonCommand, resumeConversationSession } from "./daemonCommandUtils";
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

for (const axis of ["owner_device_id", "session_id", "conversation_id"] as const) {
  test(`omitted hibernate request ID keeps bounded pending dedupe and distinguishes ${axis}`, async () => {
    const conv: any = { _id: "conv", user_id: "owner", session_id: "session", owner_device_id: "device" };
    const db = makeFakeDb({ managed_sessions: [{ _id: "managed", conversation_id: "conv", user_id: "owner", session_id: "session" }], daemon_commands: [] });
    const ctx = { db };
    const first = await enqueueHibernateSession(ctx, conv);
    expect(await enqueueHibernateSession(ctx, conv)).toEqual({ ...first, deduplicated: true });
    expect(db._tables.daemon_commands[0].request_id).toBeUndefined();
    await db.patch(first.command_id, { _creationTime: Date.now() - 31_000 });
    const fresh = await enqueueHibernateSession(ctx, conv);
    expect(fresh.deduplicated).toBe(false);
    expect(fresh.command_id).not.toBe(first.command_id);
    await db.patch(fresh.command_id, { executed_at: Date.now(), result: "hibernated" });
    const afterCompletion = await enqueueHibernateSession(ctx, conv);
    expect(afterCompletion.deduplicated).toBe(false);
    const next = { ...conv, [axis === "conversation_id" ? "_id" : axis]: "new-target" };
    await db.patch("managed", { conversation_id: next._id, session_id: next.session_id });
    const retargeted = await enqueueHibernateSession(ctx, next);
    expect(retargeted.deduplicated).toBe(false);
    expect(retargeted.command_id).not.toBe(afterCompletion.command_id);
    expect(db._tables.daemon_commands).toHaveLength(4);
  });
}
