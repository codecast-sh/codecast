// ct-98180: a cancel must not report "cancelled" for a message the agent may
// already hold. A row in "injected" has been pasted into the session; a
// "failed" row with the unconfirmed reason had its paste accepted with no
// echo yet. Every web caller reads the returned status to decide whether to
// warn ("may already have reached the session") and whether to hand the text
// back to the composer, so a plain "cancelled" here tells the person they
// withdrew a message the agent goes on to act on.
import { describe, expect, test } from "bun:test";
import { cancelPendingMessage, cancelPendingMessageForUser, enqueuePendingMessage, UNCONFIRMED_DELIVERY_REASON } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

const OWNER = "owner" as any;

function world(message: Record<string, unknown> | null) {
  const db = makeFakeDb({
    users: [{ _id: OWNER }],
    conversations: [{ _id: "conv", user_id: OWNER, owner_device_id: "device", status: "active", has_pending_messages: true }],
    pending_messages: message ? [{ _id: "msg", conversation_id: "conv", from_user_id: OWNER, owner_user_id: OWNER, client_id: "client", content: "do the thing", retry_count: 0, created_at: 1, ...message }] : [],
  });
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) },
    scheduler: { runAfter: async () => "scheduled" },
  } as any;
  return { ctx, db, row: () => db._tables.pending_messages.find((r: any) => r.client_id === "client") };
}

const forUser = (ctx: any) => cancelPendingMessageForUser(ctx, OWNER, "conv" as any, { messageId: "msg" });
const legacy = async (ctx: any) => (await (cancelPendingMessage as any)._handler(ctx, { message_id: "msg" })).status;

const INJECTED = { status: "injected", paste_verified_at: 1 };
const UNCONFIRMED = { status: "failed", delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON, paste_verified_at: 1 };

describe("a person's cancel of a message that may already have reached the agent", () => {
  test("an injected (pasted) row answers injected and is left for its echo", async () => {
    const w = world(INJECTED);
    expect(await forUser(w.ctx)).toBe("injected");
    expect(w.row().status).toBe("injected");
  });

  test("a failed-unconfirmed row stops, answers unconfirmed, and a repeat cancel still says so", async () => {
    const w = world(UNCONFIRMED);
    expect(await forUser(w.ctx)).toBe("unconfirmed");
    expect(w.row().status).toBe("cancelled");
    expect(w.row().paste_verified_at).toBe(1);
    expect(await forUser(w.ctx)).toBe("unconfirmed");
  });

  test("queued and held rows still cancel; a delivered row says delivered", async () => {
    for (const status of ["pending", "held"]) {
      const w = world({ status });
      expect(await forUser(w.ctx)).toBe("cancelled");
      expect(await forUser(w.ctx)).toBe("cancelled");
    }
    expect(await forUser(world({ status: "delivered" }).ctx)).toBe("delivered");
  });
});

describe("the daemon's give-up cancel (cancelPendingMessage)", () => {
  test("an injected or unconfirmed row stops but answers unconfirmed", async () => {
    for (const row of [INJECTED, UNCONFIRMED]) {
      const w = world(row);
      expect(await legacy(w.ctx)).toBe("unconfirmed");
      expect(w.row().status).toBe("cancelled");
      expect(await legacy(w.ctx)).toBe("unconfirmed");
    }
  });

  test("a queued row cancels; a delivered row says delivered", async () => {
    expect(await legacy(world({ status: "pending" }).ctx)).toBe("cancelled");
    expect(await legacy(world({ status: "delivered" }).ctx)).toBe("delivered");
  });
});

describe("a cancel that reaches the server before its send", () => {
  test("the late send lands on the cancelled row and nothing is queued for the agent", async () => {
    const w = world(null);
    expect(await cancelPendingMessageForUser(w.ctx, OWNER, "conv" as any, { clientId: "client" })).toBe("cancelled");
    const conversation = await w.db.get("conv");
    await enqueuePendingMessage(w.ctx, conversation, OWNER, { content: "do the thing", client_id: "client", human: true });
    const rows = w.db._tables.pending_messages;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("cancelled");
  });

  test("a cancel by server id that finds nothing stays not_found", async () => {
    const w = world(null);
    expect(await forUser(w.ctx)).toBe("not_found");
    expect(w.db._tables.pending_messages).toHaveLength(0);
  });
});
