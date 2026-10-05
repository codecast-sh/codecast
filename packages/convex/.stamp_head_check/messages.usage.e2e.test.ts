import { expect, test } from "bun:test";
import { addMessage, addMessages } from "./messages";
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
