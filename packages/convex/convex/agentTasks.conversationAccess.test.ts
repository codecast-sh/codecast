// F17: a trigger names conversations by raw id, and each one must be a
// conversation the caller can read. A stranger's id is refused before the
// trigger writes armed state onto it or posts into it.
import { describe, expect, test } from "bun:test";
import { createTask } from "./agentTasks";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";

const ME = "users_me" as any;
const OTHER = "users_other" as any;

async function seed() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }, { _id: OTHER, name: "Other" }],
    api_tokens: [{ _id: "api_tokens_me", user_id: ME, token_hash: await hashToken("me-token") }],
    team_memberships: [],
    teams: [],
    conversations: [
      { _id: "conversations_mine", user_id: ME, session_id: "sess-mine", is_private: true },
      { _id: "conversations_theirs", user_id: OTHER, session_id: "sess-theirs", is_private: true },
    ],
    agent_tasks: [],
    counters: [],
  };
  const ctx = { db: makeFakeDb(tables), scheduler: { runAfter: async () => null } } as any;
  return { ctx, tables };
}

const base = { api_token: "me-token", title: "Check CI", prompt: "check", schedule_type: "once" as const, run_at: Date.now() + 60_000 };

describe("createTask conversation ids (F17)", () => {
  test("refuses another user's conversation as the inject home or the post target", async () => {
    const { ctx, tables } = await seed();
    await expect((createTask as any)._handler(ctx, { ...base, originating_conversation_id: "conversations_theirs" })).rejects.toThrow(/No session of yours/);
    await expect((createTask as any)._handler(ctx, { ...base, target_conversation_id: "conversations_theirs" })).rejects.toThrow(/No session of yours/);
    expect(tables.agent_tasks).toHaveLength(0);
    expect(tables.conversations[1].armed_trigger_kind).toBeUndefined();
  });

  test("drops an unreadable creator id and keeps the caller's own conversations", async () => {
    const { ctx, tables } = await seed();
    await (createTask as any)._handler(ctx, {
      ...base,
      originating_conversation_id: "conversations_mine",
      target_conversation_id: "conversations_mine",
      created_by_conversation_id: "conversations_theirs",
    });
    expect(tables.agent_tasks).toHaveLength(1);
    expect(tables.agent_tasks[0].originating_conversation_id).toBe("conversations_mine");
    expect(tables.agent_tasks[0].target_conversation_id).toBe("conversations_mine");
    expect(tables.agent_tasks[0].created_by_conversation_id).toBeUndefined();
  });
});
