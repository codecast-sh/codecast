import { describe, expect, test } from "bun:test";
import { addMessages } from "./messages";
import { makeFakeDb } from "./testDb";

// A daemon that stamps echoes (echo_ids) names the pending row each user turn
// delivered; the server settles that row in the same write and pairs nothing
// by its words. A batch without the flag is a daemon from before delivery ids,
// still paired by text.

const pending = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  _id: id, conversation_id: "conversation", from_user_id: "teammate", owner_user_id: "owner",
  content, status: "injected", created_at: 1_000, retry_count: 0, client_id: `client-${id}`, ...extra,
});

function setup(rows: any[]) {
  const db = makeFakeDb({
    users: [{ _id: "owner" }, { _id: "teammate" }],
    conversations: [
      { _id: "conversation", user_id: "owner", is_private: true, agent_type: "claude", message_count: 0, updated_at: 1, status: "active", skip_title_generation: true },
      { _id: "elsewhere", user_id: "owner", is_private: true, agent_type: "claude", message_count: 0, updated_at: 1, status: "active", skip_title_generation: true },
    ],
    pending_messages: rows,
  });
  const ctx = {
    db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) },
    scheduler: { runAfter: async () => "scheduled" }, storage: { getUrl: async () => null },
  };
  const write = (messages: any[], echoIds = true) =>
    (addMessages as any)._handler(ctx, { conversation_id: "conversation", messages, ...(echoIds ? { echo_ids: true } : {}) });
  const row = (id: string) => db._tables.pending_messages.find((r: any) => r._id === id);
  const messages = () => db._tables.messages;
  return { db, write, row, messages };
}

const turn = (uuid: string, content: string, deliveryIds?: string[]) =>
  ({ role: "user", message_uuid: uuid, content, timestamp: 5_000, ...(deliveryIds ? { delivery_ids: deliveryIds } : {}) });

describe("adopting an echo by its delivery id", () => {
  test("the turn takes the row's sender, client id and words, and the row is delivered and tied to it", async () => {
    const { write, row, messages } = setup([pending("pm1", "deploy the fix")]);
    // The terminal mangled the echo; the id still names the delivery.
    await write([turn("u1", "\x01deploy  the fix", ["pm1"])]);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ client_id: "client-pm1", from_user_id: "teammate", content: "deploy the fix" });
    expect(row("pm1")).toMatchObject({ status: "delivered", echo_message_id: messages()[0]._id });
  });

  test("an unstamped turn in a stamped batch is nobody's delivery, whatever its words", async () => {
    const { write, row, messages } = setup([pending("pm1", "continue")]);
    await write([turn("typed", "continue")]);
    expect(messages()[0].client_id).toBeUndefined();
    expect(messages()[0].from_user_id).toBeUndefined();
    expect(row("pm1").status).toBe("injected");
  });

  test("a re-upload of the same turn is a no-op, and a first upload that missed the id converges on the stored row", async () => {
    const { write, row, messages } = setup([pending("pm1", "go")]);
    await write([turn("u1", "go")]);
    expect(row("pm1").status).toBe("injected");
    await write([turn("u1", "go", ["pm1"])]);
    await write([turn("u1", "go", ["pm1"])]);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ client_id: "client-pm1", from_user_id: "teammate" });
    expect(row("pm1")).toMatchObject({ status: "delivered", echo_message_id: messages()[0]._id });
  });

  test("a turn that carried two sends settles both and keeps the agent's words", async () => {
    const { write, row, messages } = setup([pending("pm1", "first"), pending("pm2", "second", { created_at: 1_100 })]);
    await write([turn("u1", "first\nsecond", ["pm1", "pm2"])]);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({ client_id: "client-pm1", content: "first\nsecond" });
    expect([row("pm1").status, row("pm2").status]).toEqual(["delivered", "delivered"]);
    expect(row("pm2").echo_message_id).toBe(messages()[0]._id);
  });

  test("a second turn naming an already echoed row never takes its client id", async () => {
    const { write, messages } = setup([pending("pm1", "go")]);
    await write([turn("u1", "go", ["pm1"])]);
    await write([{ ...turn("u2", "go again", ["pm1"]), timestamp: 9_000 }]);
    expect(messages().map((m: any) => m.client_id)).toEqual(["client-pm1", undefined]);
  });

  test("a row the daemon delivered here for another of the owner's conversations settles, and keeps its client id home", async () => {
    // A plan parent's message, handed to its child session.
    const { row, write, messages } = setup([pending("pm1", "go", { conversation_id: "elsewhere" })]);
    await write([turn("u1", "go", ["pm1", "not-an-id"])]);
    expect(messages()[0].client_id).toBeUndefined();
    expect(row("pm1")).toMatchObject({ status: "delivered", echo_message_id: messages()[0]._id });
  });

  test("another person's row is never settled by this conversation's echo", async () => {
    const { row, write } = setup([pending("pm1", "go", { conversation_id: "elsewhere", owner_user_id: "teammate", from_user_id: "teammate" })]);
    await write([turn("u1", "go", ["pm1"])]);
    expect(row("pm1").status).toBe("injected");
  });

  test("a late echo settles a row that had failed as unconfirmed", async () => {
    const { row, write, messages } = setup([pending("pm1", "go", { status: "failed", delivery_disposition_reason: "unconfirmed" })]);
    await write([turn("u1", "go", ["pm1"])]);
    expect(row("pm1").status).toBe("delivered");
    expect(messages()[0].client_id).toBe("client-pm1");
  });

  test("a batch from a daemon without delivery ids is still paired by its words", async () => {
    const { write, row, messages } = setup([pending("pm1", "continue")]);
    await write([turn("u1", "continue")], false);
    expect(messages()[0].client_id).toBe("client-pm1");
    expect(row("pm1").status).toBe("delivered");
  });
});
