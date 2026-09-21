import { describe, expect, test } from "bun:test";
import { enqueuePendingMessage, claimPendingMessageForDaemon, markPendingDelivered } from "./pendingMessages";
import { makeFakeDb } from "./testDb";

function world() {
  const conversation = { _id: "conv", user_id: "owner", owner_device_id: "device", session_id: "native", status: "active" };
  const db = makeFakeDb({ conversations: [conversation], pending_messages: [] });
  return { ctx: { db }, conversation };
}

describe("scheduled wake backlog", () => {
  test.each(["pending", "injected", "failed", "undeliverable", "held"])("coalesces identical %s wakes and permits the next wake after delivery", async status => {
    const { ctx, conversation } = world();
    const fields = { content: "<scheduled-task task-id=\"trigger\">Verify the fix</scheduled-task>", origin: "scheduler" as const };
    const first = await enqueuePendingMessage(ctx, conversation, "owner" as any, fields);
    await ctx.db.patch(first, { status });
    for (let i = 0; i < 5; i++) expect(await enqueuePendingMessage(ctx, conversation, "owner" as any, fields)).toBe(first);
    await ctx.db.patch(first, { status: "pending" });
    const claimed = await claimPendingMessageForDaemon(ctx, first, "owner" as any, "device");
    expect(claimed?.content).toBe(fields.content);
    await markPendingDelivered(ctx, claimed);
    expect(await enqueuePendingMessage(ctx, conversation, "owner" as any, fields)).not.toBe(first);
  });

  test("preserves repeated user messages and different scheduler content", async () => {
    const { ctx, conversation } = world();
    const first = await enqueuePendingMessage(ctx, conversation, "owner" as any, { content: "continue" });
    expect(await enqueuePendingMessage(ctx, conversation, "owner" as any, { content: "continue" })).not.toBe(first);
    const wake = await enqueuePendingMessage(ctx, conversation, "owner" as any, { content: "first", origin: "scheduler" });
    expect(await enqueuePendingMessage(ctx, conversation, "owner" as any, { content: "second", origin: "scheduler" })).not.toBe(wake);
  });

  test.each(["delivered", "cancelled"])("does not coalesce a %s wake", async status => {
    const { ctx, conversation } = world();
    const fields = { content: "tick", origin: "scheduler" as const };
    const first = await enqueuePendingMessage(ctx, conversation, "owner" as any, fields);
    await ctx.db.patch(first, { status });
    expect(await enqueuePendingMessage(ctx, conversation, "owner" as any, fields)).not.toBe(first);
  });

  test("does not revive a prior kill generation", async () => {
    const { ctx, conversation } = world();
    const fields = { content: "tick", origin: "scheduler" as const };
    const first = await enqueuePendingMessage(ctx, conversation, "owner" as any, fields);
    const killed = { ...conversation, pending_kill_generation: 1 };
    await ctx.db.patch("conv", { pending_kill_generation: 1 });
    expect(await enqueuePendingMessage(ctx, killed, "owner" as any, fields)).not.toBe(first);
  });
});
