import { describe, expect, spyOn, test } from "bun:test";
import { _continueFork, setSessionError, switchSessionAgent } from "./conversations";
import { makeFakeDb } from "./testDb";
import { AGENT_SWITCH_NOTICE_PREFIX } from "@codecast/shared/contracts";

const USER = "users_owner";
const CONV = "conversations_switch";

function ctxFor(db: ReturnType<typeof makeFakeDb>) {
  return {
    auth: {
      getUserIdentity: async () => ({ subject: `${USER}|session` }),
    },
    db,
  };
}

function seedConv(extra: Record<string, unknown> = {}) {
  return makeFakeDb({
    conversations: [{
      _id: CONV,
      user_id: USER,
      session_id: "sess-claude-1",
      agent_type: "claude_code",
      project_path: "/repo",
      git_root: "/repo",
      message_count: 4,
      status: "active",
      updated_at: 1,
      model: "claude-sonnet-4-6",
    }],
    messages: [],
    pending_messages: [],
    daemon_commands: [],
    devices: [],
    ...extra,
  });
}

describe("switchSessionAgent", () => {
  test("stays on the same conversation, inserts a divider, and reconstitutes", async () => {
    const db = seedConv();
    const result = await (switchSessionAgent as any)._handler(ctxFor(db), {
      conversation_id: CONV,
      agent_type: "codex",
    });

    expect(result.conversation_id).toBe(CONV);
    expect(result.switched).toBe(true);
    expect(result.reconstituted).toBe(true);

    const conv = db._tables.conversations.find((r: any) => r._id === CONV);
    expect(conv.agent_type).toBe("codex");

    const notice = db._tables.messages.find((m: any) => m.subtype === "agent_switch");
    expect(notice).toBeDefined();
    expect(notice.conversation_id).toBe(CONV);
    expect(notice.content.startsWith(AGENT_SWITCH_NOTICE_PREFIX)).toBe(true);
    expect(notice.content).toContain("Codex");
    expect(notice.content).toContain("Claude");

    const resume = db._tables.daemon_commands.find((r: any) => r.command === "resume_session");
    expect(resume).toBeDefined();
    const args = JSON.parse(resume.args);
    expect(args.switch_agent).toBe(true);
    expect(args.force_reconstitute).toBe(true);
    expect(args.agent_type).toBe("codex");
    expect(args.conversation_id).toBe(CONV);
  });

  test("does not insert a second conversation", async () => {
    const db = seedConv();
    await (switchSessionAgent as any)._handler(ctxFor(db), {
      conversation_id: CONV,
      agent_type: "codex",
    });
    expect(db._tables.conversations).toHaveLength(1);
  });

  test.each([false, true])("does not lose a switch behind an earlier fork resume (claimed: %s)", async claimed => {
    const db = seedConv();
    await db.insert("daemon_commands", {
      user_id: USER,
      command: "resume_session",
      args: JSON.stringify({ conversation_id: CONV, agent_type: "claude", fork: true }),
      created_at: Date.now(),
      ...(claimed ? { claimed_by: "daemon-boot" } : {}),
    });
    await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "codex" });
    const commands = db._tables.daemon_commands;
    expect(commands.map((row: any) => row.command)).toEqual(["resume_session", "kill_session", "resume_session"]);
    expect(JSON.parse(commands.at(-1).args)).toMatchObject({ agent_type: "codex", switch_agent: true });
  });

  test.each([0, 500])("switching during fork copy waits for all history (%s messages copied)", async messageCount => {
    const db = seedConv();
    Object.assign(db._tables.conversations[0], {
      message_count: messageCount,
      fork_status: "copying",
      forked_from: "conversations_parent",
      fork_copy_cursor: messageCount,
      fork_daemon_args: JSON.stringify({ conversation_id: CONV, agent_type: "claude", fork: true, _target_device_id: "mac" }),
    });
    await db.insert("messages", { conversation_id: "conversations_parent", role: "assistant", content: "Last inherited message", timestamp: messageCount + 1 });
    const ctx = ctxFor(db);
    await (switchSessionAgent as any)._handler(ctx, { conversation_id: CONV, agent_type: "codex" });
    expect(db._tables.daemon_commands).toHaveLength(0);
    expect(db._tables.conversations[0].agent_type).toBe("codex");
    await (_continueFork as any)._handler(ctx, { forkId: CONV });
    const commands = db._tables.daemon_commands;
    expect(commands.map((row: any) => row.command)).toEqual(["kill_session", "resume_session"]);
    expect(JSON.parse(commands[1].args)).toMatchObject({ conversation_id: CONV, agent_type: "codex", switch_agent: true, force_reconstitute: true });
    expect(commands.every((row: any) => row.target_device_id === "mac")).toBe(true);
    expect(commands[0].created_at).toBeLessThan(commands[1].created_at);
    expect(db._tables.conversations[0].fork_status).toBe("complete");
    expect(db._tables.conversations[0].fork_daemon_args).toBeUndefined();
    expect(db._tables.messages.filter((row: any) => row.conversation_id === CONV).map((row: any) => row.content)).toContain("Last inherited message");
    await (_continueFork as any)._handler(ctx, { forkId: CONV });
    expect(commands).toHaveLength(2);
  });

  test("rejects a no-op", async () => {
    const db = seedConv();
    await expect((switchSessionAgent as any)._handler(ctxFor(db), {
      conversation_id: CONV,
    })).rejects.toThrow("Nothing to switch");
  });

  test("retries a failed Codex switch without adding another divider", async () => {
    const db = seedConv();
    Object.assign(db._tables.conversations[0], { agent_type: "codex", session_error: "Codex history import failed" });
    const beforeCount = db._tables.conversations[0].message_count;

    const result = await (switchSessionAgent as any)._handler(ctxFor(db), {
      conversation_id: CONV,
      agent_type: "codex",
    });

    expect(result.reconstituted).toBe(true);
    expect(db._tables.messages).toHaveLength(0);
    expect(db._tables.conversations[0].message_count).toBe(beforeCount);
    const resume = db._tables.daemon_commands.find((row: any) => row.command === "resume_session");
    expect(JSON.parse(resume.args)).toMatchObject({ agent_type: "codex", switch_agent: true, force_reconstitute: true });
  });
});

describe("agent switch failure reporting", () => {
  test.each([undefined, "Codex history import failed"])("does not rewrite an unchanged error: %s", async error => {
    const db = seedConv();
    db._tables.conversations[0].session_error = error;
    const patch = spyOn(db, "patch");
    await (setSessionError as any)._handler(ctxFor(db), { conversation_id: CONV, error, force: true });
    expect(patch).not.toHaveBeenCalled();
    patch.mockRestore();
  });

  test("clears an error once even when several devices repeat the clear", async () => {
    const db = seedConv();
    db._tables.conversations[0].session_error = "Codex history import failed";
    const patch = spyOn(db, "patch");
    for (let i = 0; i < 4; i++) await (setSessionError as any)._handler(ctxFor(db), { conversation_id: CONV });
    expect(db._tables.conversations[0].session_error).toBeUndefined();
    expect(patch).toHaveBeenCalledTimes(1);
    patch.mockRestore();
  });

  test("forces the import error past a stale managed-session heartbeat", async () => {
    const db = seedConv({
      managed_sessions: [{
        _id: "managed_old_agent",
        conversation_id: CONV,
        session_id: "sess-claude-1",
        user_id: USER,
        last_heartbeat: Date.now(),
      }],
    });

    await (setSessionError as any)._handler(ctxFor(db), {
      conversation_id: CONV,
      error: "Codex history import failed",
    });
    expect(db._tables.conversations[0].session_error).toBeUndefined();

    await (setSessionError as any)._handler(ctxFor(db), {
      conversation_id: CONV,
      error: "Codex history import failed",
      force: true,
    });
    expect(db._tables.conversations[0].session_error).toBe("Codex history import failed");
  });
});

describe("same-agent model changes", () => {
  const seedAgent = (agent_type: string, model: string) => {
    const db = seedConv();
    Object.assign(db._tables.conversations[0], { agent_type, model, effort: "high" });
    return db;
  };

  test("carries Codex model and effort through the restart command", async () => {
    const db = seedAgent("codex", "gpt-5.6-sol");
    await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, model: "gpt-6-astra", effort: "ultra" });
    const resume = db._tables.daemon_commands.find((row: any) => row.command === "resume_session");
    expect(JSON.parse(resume.args)).toMatchObject({ agent_type: "codex", model: "gpt-6-astra", effort: "ultra", switch_agent: true });
    expect(db._tables.conversations).toHaveLength(1);
  });

  test.each(["opencode", "pi", "grok"])("uses native resume to retain %s history", async agent => {
    const db = seedAgent(agent, "old");
    const model = agent === "grok" ? "grok-4.6" : "openai/gpt-5.4";
    await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, model });
    const resume = db._tables.daemon_commands.find((row: any) => row.command === "resume_session");
    const args = JSON.parse(resume.args);
    expect(args).toMatchObject({ agent_type: agent, model, session_id: "sess-claude-1" });
    expect(args.switch_agent).toBeUndefined();
    expect(args.force_reconstitute).toBeUndefined();
  });

  test("coalesces a second effort selection into the pending model switch", async () => {
    const db = seedAgent("codex", "gpt-5.6-sol");
    await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, model: "gpt-6-astra" });
    await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, effort: "ultra" });
    const resumes = db._tables.daemon_commands.filter((row: any) => row.command === "resume_session");
    expect(resumes).toHaveLength(1);
    expect(JSON.parse(resumes[0].args)).toMatchObject({ model: "gpt-6-astra", effort: "ultra" });
  });
});

test("queues a fresh switch after the daemon already claimed the earlier selection", async () => {
  const db = seedConv();
  Object.assign(db._tables.conversations[0], { agent_type: "codex", model: "gpt-5.6-sol" });
  await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, model: "gpt-6-astra" });
  const first = db._tables.daemon_commands.find((row: any) => row.command === "resume_session");
  first.claimed_by = "daemon-boot";
  await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, effort: "ultra" });
  const resumes = db._tables.daemon_commands.filter((row: any) => row.command === "resume_session");
  expect(resumes).toHaveLength(2);
  expect(JSON.parse(resumes[1].args)).toMatchObject({ model: "gpt-6-astra", effort: "ultra" });
});

// The row's agent_type is a promise the daemon must keep. Switching a session
// WITH history into a client whose transcript codecast cannot rebuild (cursor,
// opencode; grok and pi until their writers landed) used to stamp the
// row, kill the pane, fail in the daemon, and leave the old agent auto-resuming
// under the wrong label — hiding fork and the model rail behind grok's
// capabilities on a Claude session (2026-09-05). Refuse before any write.
describe("switchSessionAgent refuses agents that cannot rebuild history", () => {
  test("a fork with zero messages copied still requires history import support", async () => {
    const db = seedConv();
    Object.assign(db._tables.conversations[0], { message_count: 0, fork_status: "copying" });
    await expect((switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "cursor" })).rejects.toThrow(/Cursor cannot take over/);
    expect(db._tables.daemon_commands).toHaveLength(0);
    expect(db._tables.conversations[0].agent_type).toBe("claude_code");
  });

  test("cursor on a session with messages: no patch, no divider, no daemon command", async () => {
    const db = seedConv();
    await expect(
      (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "cursor" }),
    ).rejects.toThrow(/Cursor cannot take over/);

    const conv = db._tables.conversations.find((r: any) => r._id === CONV);
    expect(conv.agent_type).toBe("claude_code");
    expect(conv.model).toBe("claude-sonnet-4-6");
    expect(db._tables.messages.length).toBe(0);
    expect(db._tables.daemon_commands.length).toBe(0);
  });

  test("grok on a session with messages is a rebuild and goes through", async () => {
    const db = seedConv();
    const result = await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "grok" });
    expect(result.switched).toBe(true);
    expect(result.reconstituted).toBe(true);
    const conv = db._tables.conversations.find((r: any) => r._id === CONV);
    expect(conv.agent_type).toBe("grok");
  });

  test("pi on a session with messages is a rebuild and goes through", async () => {
    const db = seedConv();
    const result = await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "pi" });
    expect(result.switched).toBe(true);
    expect(result.reconstituted).toBe(true);
    expect(db._tables.conversations.find((r: any) => r._id === CONV).agent_type).toBe("pi");
  });

  test("cursor on a blank session is a relaunch and goes through", async () => {
    const db = seedConv({
      conversations: [{
        _id: CONV,
        user_id: USER,
        session_id: "sess-blank",
        agent_type: "claude_code",
        project_path: "/repo",
        git_root: "/repo",
        message_count: 0,
        status: "active",
        updated_at: 1,
      }],
    });
    const result = await (switchSessionAgent as any)._handler(ctxFor(db), { conversation_id: CONV, agent_type: "cursor" });
    expect(result.switched).toBe(true);
    expect(result.blank).toBe(true);
    const conv = db._tables.conversations.find((r: any) => r._id === CONV);
    expect(conv.agent_type).toBe("cursor");
  });
});
