import { describe, expect, test } from "bun:test";
import { addMessage, addMessages, getConversationImages } from "./messages";
import { makeFakeDb } from "./testDb";

describe.each([false, true])("gallery index on transcript updates (batch=%s)", batch => {
  const setup = () => {
    const db = makeFakeDb({
      users: [{ _id: "owner" }],
      conversations: [{
        _id: "conversation", user_id: "owner", is_private: true, agent_type: "codex",
        message_count: 0, updated_at: 1, status: "active", skip_title_generation: true,
      }],
    });
    const ctx = {
      db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) },
      scheduler: { runAfter: async () => "scheduled" }, storage: { getUrl: async () => null },
    };
    const write = (message: Record<string, unknown>) => batch
      ? (addMessages as any)._handler(ctx, { conversation_id: "conversation", messages: [message] })
      : (addMessage as any)._handler(ctx, { conversation_id: "conversation", ...message });
    const gallery = () => (getConversationImages as any)._handler(ctx, { conversation_id: "conversation" });
    return { db, write, gallery };
  };
  const message = {
    role: "assistant", content: "", message_uuid: "shot", timestamp: 10,
    tool_calls: [{ id: "shot", name: "commandExecution", input: '{"command":"cast browser shot"}' }],
  };
  const images = [
    { media_type: "image/png", storage_id: "screenshot-1", tool_use_id: "shot" },
    { media_type: "image/png", storage_id: "screenshot-2", tool_use_id: "shot" },
  ];

  test("a command's late screenshots enter the gallery once at the original message position", async () => {
    const { db, write, gallery } = setup();
    await write(message);
    expect(await gallery()).toEqual([]);
    const completed = { ...message, timestamp: 20, images,
      tool_results: [{ tool_use_id: "shot", content: "captured" }] };
    await write(completed);
    await write(completed);
    const rows = await gallery();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => [r.storage_id, r.timestamp, r.seq, r.message_id])).toEqual([
      ["screenshot-1", 10, 0, db._tables.messages[0]._id],
      ["screenshot-2", 10, 1, db._tables.messages[0]._id],
    ]);
    expect(db._tables.messages).toHaveLength(1);
    expect(db._tables.messages[0].images).toEqual(images);
    expect((await db.get("conversation")).message_count).toBe(1);
  });

  test("resync repairs an absent gallery index even when the message already has its images", async () => {
    const { db, write, gallery } = setup();
    await write({ ...message, images });
    db._tables.conversation_images = [];
    await write({ ...message, images });
    expect((await gallery()).map((r: any) => r.storage_id)).toEqual(["screenshot-1", "screenshot-2"]);
    expect(db._tables.messages).toHaveLength(1);
  });
});
