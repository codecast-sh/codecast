import { describe, expect, test } from "bun:test";
import { resolveRestartTarget, enqueueKillAndResume } from "./conversations";
import { deleteConversationBySessionIdCore } from "./cleanup";
import { makeFakeDb } from "./testDb";

// Kill & restart must work even when the conversation row was deleted
// server-side while clients keep a cached ghost (ct-36973): the restart
// resolves a live twin bound to the same session_id, or recreates a row, so
// the daemon command chain always has something to bind to.

const USER = "users_me" as any;
const OTHER = "users_other" as any;

function ctxWith(tables: Record<string, any[]>) {
  return { db: makeFakeDb(tables) } as any;
}

describe("resolveRestartTarget", () => {
  test("live owned conversation passes through untouched", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "conversations_1", user_id: USER, session_id: "s1", updated_at: 5 }],
    });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_1" as any, {});
    expect(String(conv._id)).toBe("conversations_1");
    expect(restored).toBe(false);
    expect(ctx.db._patched.length).toBe(0);
  });

  test("live conversation owned by someone else throws", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "conversations_1", user_id: OTHER, session_id: "s1" }],
    });
    await expect(resolveRestartTarget(ctx, USER, "conversations_1" as any, {})).rejects.toThrow("Not authorized");
  });

  test("live conversation run by another user but second-party-owned by caller resolves", async () => {
    // Same rule as dispatch sendMessage/resumeSession: an owned session (e.g.
    // Mr-Bot-run, assigned to this user) restarts from the owner's inbox.
    const ctx = ctxWith({
      conversations: [{ _id: "conversations_1", user_id: OTHER, owner_user_id: USER, session_id: "s1" }],
    });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_1" as any, {});
    expect(String(conv._id)).toBe("conversations_1");
    expect(restored).toBe(false);
  });

  test("ghost without session context and no recovery source throws conversation_deleted", async () => {
    const ctx = ctxWith({ conversations: [], managed_sessions: [] });
    await expect(resolveRestartTarget(ctx, USER, "conversations_gone" as any, {})).rejects.toThrow("conversation_deleted");
  });

  test("ghost without client context recovers the session from managed_sessions (old prod clients)", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_twin", user_id: USER, session_id: "s-recovered", updated_at: 10 },
      ],
      managed_sessions: [
        { _id: "managed_sessions_1", user_id: USER, conversation_id: "conversations_gone", session_id: "s-stale", last_heartbeat: 100 },
        { _id: "managed_sessions_2", user_id: USER, conversation_id: "conversations_gone", session_id: "s-recovered", last_heartbeat: 200 },
        { _id: "managed_sessions_3", user_id: OTHER, conversation_id: "conversations_gone", session_id: "s-foreign", last_heartbeat: 999 },
      ],
    });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {});
    expect(restored).toBe(true);
    expect(String(conv._id)).toBe("conversations_twin");
  });

  test("ghost without client context recovers via a prior restore's tombstone", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_twin", user_id: USER, session_id: "s1", updated_at: 10, restored_from_conversation_id: "conversations_gone" },
      ],
      managed_sessions: [],
    });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {});
    expect(restored).toBe(true);
    expect(String(conv._id)).toBe("conversations_twin");
  });

  test("restoring stamps the tombstone on the twin so stale links can heal", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_twin", user_id: USER, session_id: "s1", updated_at: 10 },
      ],
    });
    const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, { session_id: "s1" });
    expect(conv.restored_from_conversation_id).toBe("conversations_gone");
  });

  test("recreating stamps the tombstone on the new row too", async () => {
    const ctx = ctxWith({ conversations: [], directory_team_mappings: [] });
    const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, { session_id: "s1" });
    expect(conv.restored_from_conversation_id).toBe("conversations_gone");
  });

  test("ghost with a live twin targets the twin and resurfaces it", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_twin", user_id: USER, session_id: "s1", updated_at: 10, status: "completed", inbox_dismissed_at: 123 },
      ],
    });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, { session_id: "s1" });
    expect(String(conv._id)).toBe("conversations_twin");
    expect(restored).toBe(true);
    expect(conv.status).toBe("active");
    expect(conv.inbox_dismissed_at).toBeUndefined();
  });

  test("multiple twins: picks the NEWEST by updated_at, never creation order", async () => {
    // Regression for the .first() foot-gun: by_session_id creation order
    // resolved to the oldest twin — cleanup once deleted a live original that
    // way. Restart must bind to the most recently active row instead.
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_old", user_id: USER, session_id: "s1", updated_at: 10 },
        { _id: "conversations_new", user_id: USER, session_id: "s1", updated_at: 99 },
        { _id: "conversations_other", user_id: OTHER, session_id: "s1", updated_at: 200 },
      ],
    });
    const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, { session_id: "s1" });
    expect(String(conv._id)).toBe("conversations_new");
  });

  test("ghost with no twin recreates a minimal row from the cached context", async () => {
    const ctx = ctxWith({ conversations: [], directory_team_mappings: [] });
    const { conv, restored } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {
      session_id: "s1",
      project_path: "/Users/me/src/proj",
      agent_type: "codex",
      title: "Restored work",
    });
    expect(restored).toBe(true);
    expect(conv.session_id).toBe("s1");
    expect(conv.project_path).toBe("/Users/me/src/proj");
    expect(conv.agent_type).toBe("codex");
    expect(conv.title).toBe("Restored work");
    expect(conv.status).toBe("active");
    expect(conv.short_id).toBe(String(conv._id).slice(0, 7));
  });

  test("unknown agent_type in cached context falls back to claude_code", async () => {
    const ctx = ctxWith({ conversations: [], directory_team_mappings: [] });
    const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {
      session_id: "s1",
      agent_type: "weird",
    });
    expect(conv.agent_type).toBe("claude_code");
  });

  test("recreated row preserves every first-class client (opencode no longer restamped claude_code)", async () => {
    for (const agent of ["opencode", "pi", "cursor", "gemini", "codex"] as const) {
      const ctx = ctxWith({ conversations: [], directory_team_mappings: [] });
      const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {
        session_id: "s1",
        agent_type: agent,
      });
      expect(conv.agent_type).toBe(agent);
    }
    // claude_code and cowork normalize to claude_code
    for (const agent of ["claude_code", "cowork"]) {
      const ctx = ctxWith({ conversations: [], directory_team_mappings: [] });
      const { conv } = await resolveRestartTarget(ctx, USER, "conversations_gone" as any, {
        session_id: "s1",
        agent_type: agent,
      });
      expect(conv.agent_type).toBe("claude_code");
    }
  });
});

describe("enqueueKillAndResume", () => {
  const conv = {
    _id: "conversations_1" as any,
    session_id: "sess-uuid",
    project_path: undefined as string | undefined,
    git_root: "/Users/me/src/proj",
    agent_type: "codex",
  };

  test("enqueues kill (with session_id) then resume (with agent_type + git_root fallback)", async () => {
    const ctx = ctxWith({ daemon_commands: [], pending_messages: [] });
    const res = await enqueueKillAndResume(ctx, USER, conv);
    expect(res.deduplicated).toBe(false);
    const cmds = ctx.db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);
    expect(cmds.map((c: any) => c.command)).toEqual(["kill_session", "resume_session"]);
    const kill = JSON.parse(cmds[0].args);
    expect(kill.session_id).toBe("sess-uuid");
    const resume = JSON.parse(cmds[1].args);
    expect(resume.session_id).toBe("sess-uuid");
    expect(resume.conversation_id).toBe("conversations_1");
    expect(resume.project_path).toBe("/Users/me/src/proj");
    expect(resume.agent_type).toBe("codex");
    expect(resume.force_reconstitute).toBeUndefined();
  });

  test("resume carries the real client — opencode/pi/cursor no longer collapse to claude", async () => {
    for (const agent of ["opencode", "pi", "cursor", "gemini", "codex"] as const) {
      const ctx = ctxWith({ daemon_commands: [], pending_messages: [] });
      await enqueueKillAndResume(ctx, USER, { ...conv, agent_type: agent });
      const cmds = ctx.db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);
      expect(JSON.parse(cmds[1].args).agent_type).toBe(agent);
    }
    // claude_code / cowork / unknown resume as claude
    for (const agent of ["claude_code", "cowork", undefined]) {
      const ctx = ctxWith({ daemon_commands: [], pending_messages: [] });
      await enqueueKillAndResume(ctx, USER, { ...conv, agent_type: agent as any });
      const cmds = ctx.db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);
      expect(JSON.parse(cmds[1].args).agent_type).toBe("claude");
    }
  });

  test("repair variant stamps force_reconstitute", async () => {
    const ctx = ctxWith({ daemon_commands: [], pending_messages: [] });
    await enqueueKillAndResume(ctx, USER, conv, { forceReconstitute: true });
    const cmds = ctx.db._inserted.filter((i: any) => i.table === "daemon_commands").map((i: any) => i.doc);
    expect(JSON.parse(cmds[1].args).force_reconstitute).toBe(true);
  });

  test("dedupes against an already-pending resume for the same conversation", async () => {
    const ctx = ctxWith({
      daemon_commands: [{
        _id: "daemon_commands_0",
        user_id: USER,
        command: "resume_session",
        args: JSON.stringify({ conversation_id: "conversations_1" }),
        executed_at: undefined,
        _creationTime: Date.now(),
      }],
      pending_messages: [],
    });
    const res = await enqueueKillAndResume(ctx, USER, conv);
    expect(res.deduplicated).toBe(true);
    expect(ctx.db._inserted.filter((i: any) => i.table === "daemon_commands").length).toBe(0);
  });
});

describe("deleteConversationBySessionIdCore", () => {
  test("refuses to guess between twins without an explicit conversation_id", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_orig", session_id: "s1", title: "Original", message_count: 155 },
        { _id: "conversations_mint", session_id: "s1", title: "Mint", message_count: 3 },
      ],
      messages: [],
    });
    const res: any = await deleteConversationBySessionIdCore(ctx, { session_id: "s1" });
    expect(res.ambiguous).toBe(true);
    expect(res.candidates.length).toBe(2);
    expect(ctx.db._deleted.length).toBe(0);
  });

  test("deletes exactly the explicitly chosen twin", async () => {
    const ctx = ctxWith({
      conversations: [
        { _id: "conversations_orig", session_id: "s1", title: "Original" },
        { _id: "conversations_mint", session_id: "s1", title: "Mint" },
      ],
      messages: [],
    });
    const res: any = await deleteConversationBySessionIdCore(ctx, { session_id: "s1", conversation_id: "conversations_mint" });
    expect(res.done).toBe(true);
    expect(ctx.db._deleted).toEqual(["conversations_mint"]);
  });

  test("single match still deletes without disambiguation", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "conversations_only", session_id: "s1" }],
      messages: [],
    });
    const res: any = await deleteConversationBySessionIdCore(ctx, { session_id: "s1" });
    expect(res.done).toBe(true);
    expect(ctx.db._deleted).toEqual(["conversations_only"]);
  });
});
