import { describe, expect, test } from "bun:test";
import { getConversationPendingMessage, retryMessage, updateMessageStatus } from "./pendingMessages";
import { updateAgentStatus } from "./managedSessions";
import { makeFakeDb } from "./testDb";

// A machine message refused because the terminal waits for a human is HELD:
// re-pended without spending a retry, with the reason stamped for the sender's
// card. And an observed working status acks only a row whose paste the daemon
// verified — the pre-paste "injected" mark alone proves nothing. Both halves
// of the 49-minute stranded cast send on 2026-09-08.

const USER = "users_hold" as any;
const CONVERSATION = "conversations_hold" as any;

function setup(row: Record<string, unknown> = {}) {
  const db = makeFakeDb({
    users: [{ _id: USER }],
    conversations: [{ _id: CONVERSATION, user_id: USER, owner_device_id: "device", status: "active", has_pending_messages: true }],
    managed_sessions: [{ _id: "managed", user_id: USER, conversation_id: CONVERSATION, session_id: "session", agent_status: "idle", agent_status_updated_at: 100, last_heartbeat: 100 }],
    pending_messages: [{
      _id: "message", conversation_id: CONVERSATION, from_user_id: USER, owner_user_id: USER,
      content: "<session-message from=\"jxsrc01\">\nhello\n</session-message>", status: "injected", retry_count: 3, created_at: 1, ...row,
    }],
  });
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) },
    scheduler: { runAfter: async () => "scheduled" },
  } as any;
  return { db, ctx, row: () => db._tables.pending_messages[0] };
}

describe("hold for a human prompt", () => {
  test("a hold re-pends without spending a retry and stamps the reason", async () => {
    const f = setup({ paste_verified_at: 50 });
    await (retryMessage as any)._handler(f.ctx, { message_id: "message", device_id: "device", hold_reason: "waiting for a human answer in the terminal" });
    expect(f.row().status).toBe("pending");
    expect(f.row().retry_count).toBe(3);
    expect(f.row().delivery_disposition_reason).toBe("waiting for a human answer in the terminal");
    expect(f.row().paste_verified_at).toBeUndefined();
  });

  test("an ordinary retry still spends one and clears a stale hold reason", async () => {
    const f = setup({ delivery_disposition_reason: "waiting for a human answer in the terminal" });
    await (retryMessage as any)._handler(f.ctx, { message_id: "message", device_id: "device" });
    expect(f.row().status).toBe("pending");
    expect(f.row().retry_count).toBe(4);
    expect(f.row().delivery_disposition_reason).toBeUndefined();
  });

  test("the sender's card can read the hold reason", async () => {
    const f = setup({ status: "pending", delivery_disposition_reason: "waiting for a human answer in the terminal" });
    const status = await (getConversationPendingMessage as any)._handler(f.ctx, { conversation_id: CONVERSATION });
    expect(status?.hold_reason).toBe("waiting for a human answer in the terminal");
  });
});

describe("paste verification and the status ack", () => {
  test("only a verified injected write stamps paste_verified_at", async () => {
    const f = setup({ status: "pending" });
    await (updateMessageStatus as any)._handler(f.ctx, { message_id: "message", status: "injected", device_id: "device" });
    expect(f.row().status).toBe("injected");
    expect(f.row().paste_verified_at).toBeUndefined();
    await (updateMessageStatus as any)._handler(f.ctx, { message_id: "message", status: "injected", device_id: "device", paste_verified: true });
    expect(typeof f.row().paste_verified_at).toBe("number");
  });

  test("an observed working status leaves a pre-paste mark alone and acks a verified paste", async () => {
    const unverified = setup();
    await (updateAgentStatus as any)._handler(unverified.ctx, { conversation_id: CONVERSATION, agent_status: "working", client_ts: 200 });
    expect(unverified.row().status).toBe("injected");
    expect(unverified.db._tables.conversations[0].has_pending_messages).toBe(true);

    const verified = setup({ paste_verified_at: 150 });
    await (updateAgentStatus as any)._handler(verified.ctx, { conversation_id: CONVERSATION, agent_status: "working", client_ts: 200 });
    expect(verified.row().status).toBe("delivered");
    expect(typeof verified.row().delivered_at).toBe("number");
    expect(verified.db._tables.conversations[0].has_pending_messages).toBe(false);
  });
});
