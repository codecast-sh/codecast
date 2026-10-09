// Closing a task ends EVERY session's binding to it, not just the closing
// caller's (docs/architecture/task-graph.md TG10). A session left bound to a
// closed task has nothing to advance and nothing that can wake it: each
// unblock path (settleWaits, releaseDependents) stops at a terminal status, so
// the block it restores after compaction would park it for good. `update`
// cleared only the caller's own conversation, which left a person closing from
// the web, or another session closing it, with the holder still bound.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { update } from "./tasks";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const TOKEN = "close-binding-token";
const HOLDER = "conversations_holder";
const CLOSER = "conversations_closer";

async function makeCtx(over: Partial<Record<string, any[]>> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [{
      _id: "tasks_ct1", short_id: "ct-1", title: "t", user_id: OWNER,
      status: "in_progress", source: "agent",
      // The holder claimed it; the closer never did.
      conversation_ids: [HOLDER],
    }],
    conversations: [
      { _id: HOLDER, session_id: "holder-uuid", user_id: OWNER, is_private: true, status: "active", active_task_id: "tasks_ct1" },
      { _id: CLOSER, session_id: "closer-uuid", user_id: OWNER, is_private: true, status: "active" },
    ],
    task_comments: [],
    task_history: [],
    entity_subscriptions: [],
    entity_conversations: [],
    counters: [],
    team_memberships: [],
    managed_sessions: [],
    ...over,
  };
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null },
    async runMutation() { return null; },
    async runQuery() { return null; },
  } as any;
  return { ctx, tables };
}

const bindingOf = (tables: Record<string, any[]>, id: string) =>
  tables.conversations.find((c) => c._id === id)?.active_task_id;

describe("closing a task releases every session bound to it", () => {
  for (const status of ["done", "dropped"] as const) {
    test(`another session closing it (${status}) releases the holder`, async () => {
      const { ctx, tables } = await makeCtx();
      await (update as any)._handler(ctx, {
        api_token: TOKEN, short_id: "ct-1", status, conversation_id: "closer-uuid",
      });
      expect(tables.tasks[0].status).toBe(status);
      expect(bindingOf(tables, HOLDER)).toBeUndefined();
    });
  }

  test("a person closing it from the web, with no session at all, releases the holder", async () => {
    const { ctx, tables } = await makeCtx();
    await (update as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-1", status: "done" });
    expect(bindingOf(tables, HOLDER)).toBeUndefined();
  });

  test("a move that is not a close leaves every binding alone", async () => {
    const { ctx, tables } = await makeCtx();
    await (update as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-1", status: "in_review", conversation_id: "closer-uuid",
    });
    expect(bindingOf(tables, HOLDER)).toBe("tasks_ct1");
  });

  test("the closing session's own binding still goes, linked to the task or not", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [{
        _id: "tasks_ct1", short_id: "ct-1", title: "t", user_id: OWNER,
        status: "in_progress", source: "agent", conversation_ids: [],
      }],
      conversations: [
        { _id: CLOSER, session_id: "closer-uuid", user_id: OWNER, is_private: true, status: "active", active_task_id: "tasks_ct1" },
      ],
    });
    await (update as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-1", status: "done", conversation_id: "closer-uuid",
    });
    expect(bindingOf(tables, CLOSER)).toBeUndefined();
  });
});
