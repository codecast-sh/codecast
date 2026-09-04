import { describe, expect, test } from "bun:test";
import { setSessionError, switchSessionAgent } from "./conversations";
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
