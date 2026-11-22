// ct-98180: a cancel must not report "cancelled" for a message the agent may
// already hold. A row in "injected" has been pasted into the session; a
// "failed" row with the unconfirmed reason had its paste accepted with no
// echo yet. Every web caller reads the returned status to decide whether to
// warn ("already reached the session") and whether to hand the text back to
// the composer, so a plain "cancelled" here tells the person they withdrew a
// message the agent goes on to act on.
import { describe, expect, test } from "bun:test";
import { cancelPendingMessageForUser, UNCONFIRMED_DELIVERY_REASON } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

function world(message: Record<string, unknown>) {
  return { db: makeFakeDb({
    conversations: [{ _id: "conv", user_id: "owner", owner_device_id: "device", has_pending_messages: true }],
    pending_messages: [{ _id: "msg", conversation_id: "conv", from_user_id: "sender", owner_user_id: "owner", client_id: "client", content: "do the thing", retry_count: 0, ...message }],
  }) };
}

describe("cancel of a message that may already have reached the agent", () => {
  test("an injected (pasted, unconfirmed) row is not reported as cancelled", async () => {
    const ctx = world({ status: "injected", paste_verified_at: 1 });
    const status = await cancelPendingMessageForUser(ctx, "sender" as any, "conv" as any, { messageId: "msg" });
    expect(status).not.toBe("cancelled");
  });

  test("a failed-unconfirmed row is not reported as cancelled", async () => {
    const ctx = world({ status: "failed", delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON, paste_verified_at: 1 });
    const status = await cancelPendingMessageForUser(ctx, "sender" as any, "conv" as any, { messageId: "msg" });
    expect(status).not.toBe("cancelled");
  });

  test("a plain queued row still cancels (guard)", async () => {
    const ctx = world({ status: "pending" });
    expect(await cancelPendingMessageForUser(ctx, "sender" as any, "conv" as any, { messageId: "msg" })).toBe("cancelled");
  });
});
