import { describe, expect, test } from "bun:test";
import { retryPendingMessageForUser, claimPendingMessageForDaemon, updatePendingMessageStatusForDaemon } from "./pendingMessages";
import { makeFakeDb } from "./testDb";
import { dispatch } from "./dispatch";

function world(status = "undeliverable", message = {}, conversation = {}) {
  return { db: makeFakeDb({
    conversations: [{ _id: "conv", user_id: "owner", owner_device_id: "device", has_pending_messages: false, ...conversation }],
    pending_messages: [{ _id: "msg", conversation_id: "conv", from_user_id: "sender", owner_user_id: "owner", client_id: "client", content: "original", image_storage_ids: ["image"], status, retry_count: 12, ...message }],
  }) };
}

describe("explicit message retry", () => {
  test("requeues the same exhausted message and delivers through the daemon rail", async () => {
    const ctx = world();
    expect(await (dispatch as any)._handler({ ...ctx, auth: { getUserIdentity: async () => ({ subject: "sender|session" }) } }, {
      action: "retryPendingMessage", args: ["conv", { clientId: "client" }],
    })).toBe("pending");
    expect(await ctx.db.get("msg")).toMatchObject({ status: "pending", retry_count: 0, content: "original", image_storage_ids: ["image"] });
    expect((await ctx.db.get("conv")).has_pending_messages).toBe(true);
    const claimed = await claimPendingMessageForDaemon(ctx, "msg" as any, "owner" as any, "device");
    expect(claimed?._id).toBe("msg");
    await updatePendingMessageStatusForDaemon(ctx, "msg" as any, "owner" as any, "device", { status: "injected" });
    await updatePendingMessageStatusForDaemon(ctx, "msg" as any, "owner" as any, "device", { status: "delivered" });
    expect((await ctx.db.get("msg")).status).toBe("delivered");
    expect(ctx.db._inserted.filter((row: any) => row.table === "pending_messages")).toHaveLength(0);
  });

  test("the owner can retry a server-backed message by its exact id", async () => {
    expect(await retryPendingMessageForUser(world("failed"), "owner" as any, "conv" as any, { messageId: "msg" })).toBe("pending");
  });

  for (const status of ["injected", "delivered", "cancelled"]) {
    test(`preserves ${status} without risking another delivery`, async () => {
      const ctx = world(status);
      expect(await retryPendingMessageForUser(ctx, "owner" as any, "conv" as any, { messageId: "msg" })).toBe(status);
      expect(ctx.db._patched).toHaveLength(0);
    });
  }

  test("never retries a different message in the conversation", async () => {
    const ctx = world();
    expect(await retryPendingMessageForUser(ctx, "owner" as any, "conv" as any, { clientId: "other" })).toBe("not_found");
    expect(ctx.db._patched).toHaveLength(0);
  });

  test("rejects unrelated users and mismatched conversation ids", async () => {
    await expect(retryPendingMessageForUser(world(), "stranger" as any, "conv" as any, { messageId: "msg" })).rejects.toThrow("Unauthorized");
    await expect(retryPendingMessageForUser(world(), "owner" as any, "other" as any, { messageId: "msg" })).rejects.toThrow("conversation");
  });

  for (const [message, conversation] of [
    [{ delivery_protocol_version: 2 }, {}],
    [{}, { execution_protocol_state: "quiescing" }],
    [{}, { pending_api_error_kind: "safety" }],
    [{ kill_generation: 0 }, { pending_kill_generation: 1 }],
  ]) {
    test(`preserves delivery barriers ${JSON.stringify({ message, conversation })}`, async () => {
      const ctx = world("undeliverable", message, conversation);
      await expect(retryPendingMessageForUser(ctx, "owner" as any, "conv" as any, { messageId: "msg" })).rejects.toThrow();
      expect(ctx.db._patched).toHaveLength(0);
    });
  }
});
