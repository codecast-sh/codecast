// A CLI write names "this session" by uuid, but conversations.session_id can
// go stale (the daemon's rebind at link/resume can lose — stranded task-run
// stub, cross-machine handover). These tests pin the two halves of the fix:
// resolveSessionConversation falls back to the managed_sessions link, and the
// task mutations treat an unresolvable session as enrichment to drop, never a
// reason to reject the write itself. Regression for the jx73p8k strand, where
// every `cast task comment/done/update` failed "Conversation not found" for a
// whole session and the comment text was lost.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addComment, create, update } from "./tasks";
import { resolveSessionConversation } from "./lib/access";
import { hashToken } from "./apiTokens";

const OWNER = "users_owner";
const STRANGER = "users_stranger";
const TOKEN = "backlink-test-token";

const LIVE_UUID = "8b830e0a-live-uuid";
const STALE_UUID = "1baf79ed-stub-uuid";

async function makeCtx(over: Partial<Record<string, any[]>> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner" },
      { _id: STRANGER, name: "Stranger", github_username: "stranger" },
    ],
    api_tokens: [{ _id: "token_1", user_id: OWNER, token_hash: await hashToken(TOKEN) }],
    tasks: [{
      _id: "tasks_ct1", short_id: "ct-1", title: "t", user_id: OWNER,
      status: "open", source: "agent",
    }],
    task_comments: [],
    task_history: [],
    entity_subscriptions: [],
    entity_conversations: [],
    counters: [],
    team_memberships: [],
    // The row a stranded session has: its session_id still holds the stub
    // uuid, so the live uuid resolves nothing directly.
    conversations: [{
      _id: "conversations_1", session_id: STALE_UUID, user_id: OWNER,
      is_private: true, status: "active",
    }],
    managed_sessions: [],
    ...over,
  };
  const db = makeFakeDb(tables);
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null },
    async runMutation() { return null; },
    async runQuery() { return null; },
  } as any;
  return { ctx, tables };
}

describe("resolveSessionConversation", () => {
  test("a live uuid the row no longer carries resolves via managed_sessions", async () => {
    const { ctx } = await makeCtx({
      managed_sessions: [{
        _id: "managed_1", session_id: LIVE_UUID, user_id: OWNER,
        conversation_id: "conversations_1",
      }],
    });
    const conv = await resolveSessionConversation(ctx, OWNER as any, LIVE_UUID);
    expect(String(conv?._id)).toBe("conversations_1");
  });

  test("a uuid known nowhere returns null instead of throwing", async () => {
    const { ctx } = await makeCtx();
    expect(await resolveSessionConversation(ctx, OWNER as any, LIVE_UUID)).toBeNull();
  });

  test("another user's private conversation is null, not a leak", async () => {
    const { ctx } = await makeCtx({
      conversations: [{
        _id: "conversations_2", session_id: LIVE_UUID, user_id: STRANGER,
        is_private: true, status: "active",
      }],
    });
    expect(await resolveSessionConversation(ctx, OWNER as any, LIVE_UUID)).toBeNull();
  });
});

describe("task writes survive a stranded session_id", () => {
  test("addComment records the text and drops the back-link", async () => {
    const { ctx, tables } = await makeCtx();
    const res = await (addComment as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-1", text: "analysis", conversation_id: LIVE_UUID,
    });
    expect(res.id).toBeTruthy();
    expect(tables.task_comments).toHaveLength(1);
    expect(tables.task_comments[0].text).toBe("analysis");
    expect(tables.task_comments[0].conversation_id).toBeUndefined();
  });

  test("addComment keeps the back-link when managed_sessions still knows the uuid", async () => {
    const { ctx, tables } = await makeCtx({
      managed_sessions: [{
        _id: "managed_1", session_id: LIVE_UUID, user_id: OWNER,
        conversation_id: "conversations_1",
      }],
    });
    await (addComment as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-1", text: "linked", conversation_id: LIVE_UUID,
    });
    expect(tables.task_comments[0].conversation_id).toBe("conversations_1");
  });

  test("update applies the status change without the link", async () => {
    const { ctx, tables } = await makeCtx();
    await (update as any)._handler(ctx, {
      api_token: TOKEN, short_id: "ct-1", status: "done", conversation_id: LIVE_UUID,
    });
    expect(tables.tasks[0].status).toBe("done");
    expect(tables.tasks[0].conversation_ids ?? []).toHaveLength(0);
  });

  test("create makes the task without a source conversation", async () => {
    const { ctx, tables } = await makeCtx();
    await (create as any)._handler(ctx, {
      api_token: TOKEN, title: "new task", conversation_id: LIVE_UUID,
    });
    const created = tables.tasks.find((t: any) => t.title === "new task");
    expect(created).toBeTruthy();
    expect(created.created_from_conversation).toBeUndefined();
  });
});
