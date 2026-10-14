import { describe, expect, test } from "bun:test";
import { enqueuePendingMessage, performSessionSend } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

// A spawned worker that sends its result to its parent marks that it reported,
// so the settle wake does not tell the parent again (workerSettle.ts). New
// input to the worker opens a turn that owes its own report.

const USER = "users_me";

function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER }],
    conversations: [
      { _id: "conversations_parent", user_id: USER, short_id: "jxparnt", session_id: "s-parent", status: "active" },
      { _id: "conversations_worker", user_id: USER, short_id: "jxworkr", session_id: "s-worker", status: "active", is_subagent: true, parent_conversation_id: "conversations_parent" },
      { _id: "conversations_other", user_id: USER, short_id: "jxother", session_id: "s-other", status: "active" },
    ],
    pending_messages: [],
  };
  return { ctx: { db: makeFakeDb(tables) }, tables, row: (id: string) => tables.conversations.find((c) => c._id === `conversations_${id}`) };
}

describe("a worker's report to its parent", () => {
  test("stamps the worker, and only a send to its own parent does", async () => {
    const { ctx, row } = world();
    await performSessionSend(ctx as any, USER as any, { to: "jxother", body: "fyi", from: "jxworkr" });
    expect(row("worker").reported_to_parent_at).toBeUndefined();
    await performSessionSend(ctx as any, USER as any, { to: "jxparnt", body: "done: all green", from: "jxworkr" });
    expect(row("worker").reported_to_parent_at).toBeGreaterThan(0);
  });

  test("new input to the worker clears the stamp", async () => {
    const { ctx, row } = world();
    await performSessionSend(ctx as any, USER as any, { to: "jxparnt", body: "done", from: "jxworkr" });
    await enqueuePendingMessage(ctx as any, row("worker"), USER as any, { content: "one more thing" });
    expect(row("worker").reported_to_parent_at).toBeUndefined();
  });
});
