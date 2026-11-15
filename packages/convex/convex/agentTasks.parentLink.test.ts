// Every trigger keeps its parent: the session its runs report to and link
// home to. tr-4885 (2026-11-08) lost it twice over: a script re-created it over
// ssh, where no calling session can be detected, and the sweep that moves
// checks out of a dying session unbinds them with `--spawn`.
import { describe, expect, test } from "bun:test";
import { createTask, updateTask } from "./agentTasks";
import { hashToken } from "./apiTokens";
import { makeFakeDb } from "./testDb";

const ME = "users_me" as any;

async function seed(tasks: any[] = []) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }],
    api_tokens: [{ _id: "api_tokens_me", user_id: ME, token_hash: await hashToken("me-token") }],
    team_memberships: [],
    teams: [],
    conversations: [
      { _id: "conversations_parent", user_id: ME, session_id: "sess-parent", short_id: "jx7c4n2", is_private: true },
      { _id: "conversations_other", user_id: ME, session_id: "sess-other", short_id: "jx7d8av", is_private: true },
    ],
    agent_tasks: tasks,
    agent_task_revisions: [],
    counters: [],
  };
  const ctx = { db: makeFakeDb(tables), scheduler: { runAfter: async () => null } } as any;
  return { ctx, tables };
}

const base = { api_token: "me-token", title: "Seven-day check", prompt: "check", schedule_type: "once" as const, run_at: Date.now() + 60_000 };
const scheduled = (overrides: Record<string, any> = {}) => ({
  _id: "agent_tasks_check", _creationTime: 1, user_id: ME, short_id: "tr-4639", title: "Seven-day check", prompt: "check",
  schedule_type: "once", status: "scheduled", run_at: Date.now() + 60_000, run_count: 0, retry_count: 0, max_retries: 3, mode: "apply", created_at: 1,
  ...overrides,
});

describe("trigger parent link", () => {
  test("--parent names the parent by short id on create", async () => {
    const { ctx, tables } = await seed();
    await (createTask as any)._handler(ctx, { ...base, created_by_session_ref: "jx7c4n2" });
    expect(tables.agent_tasks[0].created_by_conversation_id).toBe("conversations_parent");
  });

  test("a short id that matches no session is refused, not stored", async () => {
    const { ctx, tables } = await seed();
    await expect((createTask as any)._handler(ctx, { ...base, created_by_session_ref: "jx7zzzz" })).rejects.toThrow(/No session of yours/);
    expect(tables.agent_tasks).toHaveLength(0);
  });

  test("an agent session id not synced yet is kept raw for the read path", async () => {
    const { ctx, tables } = await seed();
    await (createTask as any)._handler(ctx, { ...base, created_by_session_ref: "c351336b-832d-4572-9ab7-7603806761f2" });
    expect(tables.agent_tasks[0].created_by_session_uuid).toBe("c351336b-832d-4572-9ab7-7603806761f2");
  });

  test("unbinding with --spawn keeps the bound session as the parent", async () => {
    const { ctx, tables } = await seed([scheduled({ originating_conversation_id: "conversations_parent" })]);
    await (updateTask as any)._handler(ctx, { api_token: "me-token", task_id: "agent_tasks_check", originating_conversation_id: null });
    expect(tables.agent_tasks[0].originating_conversation_id).toBeUndefined();
    expect(tables.agent_tasks[0].created_by_conversation_id).toBe("conversations_parent");
  });

  test("unbinding leaves a parent the trigger already has", async () => {
    const { ctx, tables } = await seed([scheduled({ originating_conversation_id: "conversations_other", created_by_conversation_id: "conversations_parent" })]);
    await (updateTask as any)._handler(ctx, { api_token: "me-token", task_id: "agent_tasks_check", originating_conversation_id: null });
    expect(tables.agent_tasks[0].created_by_conversation_id).toBe("conversations_parent");
  });

  test("update --parent sets the parent and records the edit", async () => {
    const { ctx, tables } = await seed([scheduled()]);
    const result = await (updateTask as any)._handler(ctx, { api_token: "me-token", task_id: "agent_tasks_check", created_by_session_ref: "jx7c4n2" });
    expect(result.changed).toEqual(["created_by_conversation_id"]);
    expect(tables.agent_tasks[0].created_by_conversation_id).toBe("conversations_parent");
    expect(tables.agent_task_revisions).toHaveLength(1);
  });
});
