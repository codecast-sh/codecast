import { describe, expect, test } from "bun:test";
import { switchSessionAgent } from "./conversations";
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
});
