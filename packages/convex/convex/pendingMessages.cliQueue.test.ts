import { describe, expect, test } from "bun:test";
import { cliQueue } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

// `cast read <session> --queued` (GitHub #88): a kill cancels the queue and the
// daemon log keeps only a message's first line, so the queue is readable here
// whole, cancelled rows included.

const USER = "users_q" as any;
const STRANGER = "users_stranger" as any;
const CONVERSATION = "conversations_q" as any;
const LONG = `line one\nline two\n${"y".repeat(500)}`;

function ctxFor(user: string) {
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ada" }, { _id: STRANGER, name: "Eve" }],
    conversations: [{ _id: CONVERSATION, user_id: USER, short_id: "jx7qqqq", title: "Worker", is_private: true, status: "active" }],
    pending_messages: [
      { _id: "p2", conversation_id: CONVERSATION, from_user_id: USER, content: "second", status: "pending", created_at: 20 },
      { _id: "p1", conversation_id: CONVERSATION, from_user_id: USER, content: LONG, status: "pending", created_at: 10, delivery_disposition_reason: "another program is running this session (pid 4551)" },
      { _id: "c1", conversation_id: CONVERSATION, from_user_id: USER, content: "cancelled by a kill", status: "cancelled", created_at: 5 },
      { _id: "d1", conversation_id: CONVERSATION, from_user_id: USER, content: "delivered", status: "delivered", created_at: 1 },
    ],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${user}|session` }) } } as any;
}

describe("cast read --queued", () => {
  test("lists queued messages whole, in delivery order, then cancelled ones; never delivered ones", async () => {
    const out = await (cliQueue as any)._handler(ctxFor(USER), { session: CONVERSATION });
    expect(out.short_id).toBe("jx7qqqq");
    expect(out.queued.map((m: any) => m.message_id)).toEqual(["p1", "p2"]);
    expect(out.queued[0].content).toBe(LONG);
    expect(out.queued[0].hold_reason).toBe("another program is running this session (pid 4551)");
    expect(out.queued[0].from_name).toBe("Ada");
    expect(out.cancelled.map((m: any) => m.content)).toEqual(["cancelled by a kill"]);
  });

  test("someone who cannot read the session gets nothing", async () => {
    await expect((cliQueue as any)._handler(ctxFor(STRANGER), { session: CONVERSATION })).rejects.toThrow(/No session found/);
  });
});
