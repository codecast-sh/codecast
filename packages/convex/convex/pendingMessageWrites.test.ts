import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  PendingMessageWriteError,
  insertEnqueuedPendingMessage,
  insertRiskResendPendingMessage,
} from "./pendingMessageWrites";

function context() {
  return { db: makeFakeDb({ pending_messages: [] }) } as any;
}

function baseFields() {
  return {
    conversationId: "conversation_1" as any,
    fromUserId: "user_sender" as any,
    ownerUserId: "user_owner" as any,
    content: "hello",
    clientId: "message-command-1",
    createdAt: 123,
  };
}

describe("pending-message insertion boundary", () => {
  test("normal admission owns defaults and copies a complete fenced allocation", async () => {
    const ctx = context();
    const id = await insertEnqueuedPendingMessage(ctx, {
      ...baseFields(),
      imageStorageIds: ["storage_1" as any],
      delivery: {
        protocolVersion: 1,
        deliveryId: "message-command-1",
        conversationSequence: 7,
        executionEpoch: 3,
      },
    });

    expect(id).toBe("pending_messages_1");
    expect(ctx.db._tables.pending_messages[0]).toMatchObject({
      conversation_id: "conversation_1",
      from_user_id: "user_sender",
      owner_user_id: "user_owner",
      content: "hello",
      client_id: "message-command-1",
      status: "pending",
      created_at: 123,
      retry_count: 0,
      delivery_protocol_version: 1,
      delivery_id: "message-command-1",
      conversation_sequence: 7,
      execution_epoch: 3,
      delivery_status: "pending",
    });
  });

  test("legacy admission stays unstamped", async () => {
    const ctx = context();
    await insertEnqueuedPendingMessage(ctx, {
      ...baseFields(),
      clientId: undefined,
    });
    const row = ctx.db._tables.pending_messages[0];
    expect(row.delivery_protocol_version).toBeUndefined();
    expect(row.delivery_id).toBeUndefined();
    expect(row.resend_of_delivery_id).toBeUndefined();
  });

  test("fenced admission rejects a missing or mismatched caller-stable id", async () => {
    for (const clientId of [undefined, "different-id"]) {
      const ctx = context();
      await expect(insertEnqueuedPendingMessage(ctx, {
        ...baseFields(),
        clientId,
        delivery: {
          protocolVersion: 1,
          deliveryId: "message-command-1",
          conversationSequence: 1,
          executionEpoch: 1,
        },
      })).rejects.toBeInstanceOf(PendingMessageWriteError);
      expect(ctx.db._tables.pending_messages).toEqual([]);
    }
  });

  test("fenced admission rejects invalid protocol coordinates before insertion", async () => {
    for (const delivery of [
      { protocolVersion: 0, deliveryId: "message-command-1", conversationSequence: 1, executionEpoch: 1 },
      { protocolVersion: 1, deliveryId: "message-command-1", conversationSequence: 0, executionEpoch: 1 },
      { protocolVersion: 1, deliveryId: "message-command-1", conversationSequence: 1, executionEpoch: Number.NaN },
    ]) {
      const ctx = context();
      await expect(insertEnqueuedPendingMessage(ctx, {
        ...baseFields(),
        delivery,
      })).rejects.toBeInstanceOf(PendingMessageWriteError);
      expect(ctx.db._tables.pending_messages).toEqual([]);
    }
  });

  test("risk resend requires a new fenced identity and persists provenance", async () => {
    const ctx = context();
    await insertRiskResendPendingMessage(ctx, {
      ...baseFields(),
      clientId: "message-command-2",
      delivery: {
        protocolVersion: 1,
        deliveryId: "message-command-2",
        conversationSequence: 8,
        executionEpoch: 3,
      },
      resendOfDeliveryId: "message-command-1",
    });
    expect(ctx.db._tables.pending_messages[0]).toMatchObject({
      client_id: "message-command-2",
      delivery_id: "message-command-2",
      resend_of_delivery_id: "message-command-1",
    });

    const rejected = context();
    await expect(insertRiskResendPendingMessage(rejected, {
      ...baseFields(),
      delivery: {
        protocolVersion: 1,
        deliveryId: "message-command-1",
        conversationSequence: 9,
        executionEpoch: 3,
      },
      resendOfDeliveryId: "message-command-1",
    })).rejects.toMatchObject({ code: "RISK_RESEND_REQUIRES_NEW_ID" });
    expect(rejected.db._tables.pending_messages).toEqual([]);
  });
});
