import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { addMessage, addMessages, projectAgentStatusOnAddMessages } from "./messages";
import { makeFakeDb } from "./testDb";

for (const batch of [false, true]) {
  test(`${batch ? "batch" : "single"} transcript ingestion persists usage without touching the shared sync head`, async () => {
    const userId = "users_usage";
    const conversationId = "conversations_usage";
    const db = makeFakeDb({
      users: [{ _id: userId }],
      conversations: [{
        _id: conversationId, user_id: userId, agent_type: "claude", owner_device_id: "device",
        message_count: 0, updated_at: 1, status: "active", skip_title_generation: true,
      }],
    });
    const ctx = {
      db,
      auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) },
      scheduler: { runAfter: async () => "scheduled" },
      storage: { getUrl: async () => null },
    };
    const query = db.query.bind(db);
    let headReads = 0;
    db.query = (table: string) => {
      if (table === "sync_heads") headReads++;
      return query(table);
    };
    for (let i = 0; i < 2; i++) {
      const message = {
        role: "assistant", content: `Response ${i}`, message_uuid: `usage-${i}`, timestamp: i + 10,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
      };
      if (batch) {
        await (addMessages as any)._handler(ctx, { conversation_id: conversationId, messages: [message] });
      } else {
        await (addMessage as any)._handler(ctx, { conversation_id: conversationId, ...message });
      }
    }
    expect(await db.get(conversationId)).toMatchObject({
      message_count: 2,
      usage_totals: { input: 20, output: 10, cache_write: 4, cache_read: 6 },
    });
    expect(db._tables.messages).toHaveLength(2);
    expect(headReads).toBe(0);
    expect(db._tables.sync_heads ?? []).toEqual([]);
    expect(db._tables.sync_actions ?? []).toEqual([]);
  });
}

test("concurrent transcript batches keep status probes local to each conversation", async () => {
  const userId = "users_streaming";
  const conversations = Array.from({ length: 24 }, (_, i) => ({
    _id: `conversations_streaming_${i}`, user_id: userId, agent_type: "claude", owner_device_id: "device",
    message_count: 0, updated_at: 1, status: "active", skip_title_generation: true,
  }));
  const db = makeFakeDb({
    users: [{ _id: userId }],
    conversations,
    managed_sessions: conversations.map((c, i) => ({
      _id: `managed_sessions_streaming_${i}`, conversation_id: c._id, agent_status: "permission_blocked",
    })),
  });
  const scheduled: Array<{ ref: any; args: any }> = [];
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) },
    scheduler: { runAfter: async (_delay: number, ref: any, args: any) => {
      scheduled.push({ ref, args });
      return "scheduled";
    } },
    storage: { getUrl: async () => null },
  };
  const query = db.query.bind(db);
  db.query = (table: string) => {
    if (table === "sync_heads") throw new Error("Transcript ingestion touched the shared sync head");
    return query(table);
  };
  await Promise.all(conversations.map(async (c, i) => {
    for (const message of [
      { role: "assistant", message_uuid: `assistant-${i}`, content: "Checking", timestamp: 10 },
      { role: "user", message_uuid: `tool-${i}`, content: "", timestamp: 11,
        tool_results: [{ tool_use_id: `read-${i}`, content: "Done" }] },
      { role: "assistant", message_uuid: `answer-${i}`, content: "Finished", timestamp: 12 },
    ]) {
      await (addMessages as any)._handler(ctx, { conversation_id: c._id, messages: [message] });
    }
    const row = await db.get(c._id);
    expect(row).toMatchObject({ message_count: 3, agent_status_probe: {
      has_assistant_message: true, has_tool_result_reply: true,
    } });
    await (projectAgentStatusOnAddMessages as any)._handler(ctx, { conversation_id: c._id });
    expect(await db.get(`managed_sessions_streaming_${i}`)).toMatchObject({ agent_status: "working" });
  }));
  expect(db._tables.messages).toHaveLength(72);
  expect(db._tables.sync_heads ?? []).toEqual([]);
  expect(db._tables.sync_actions ?? []).toEqual([]);
  expect(scheduled.filter(({ ref }) => getFunctionName(ref) === "messages:projectAgentStatusOnAddMessages")).toHaveLength(24);
});
