import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addMessage, addMessages } from "./messages";
import { setSessionError } from "./conversations";
import {
  claimPendingMessageForDaemon, collectDeliverableForOwner, enqueuePendingMessage,
  getConversationPendingMessage, healAndNotifyStuckMessages, retryMessage,
} from "./pendingMessages";
import { PendingDeliveryHeldError, requirePendingDeliveryAdmission } from "../../cli/src/pendingDeliveryAdmission";

const USER = "users_owner" as any;
const CONVERSATION = "conversations_safety" as any;
const ERROR = "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const BANNER = `Safety stop: misalignment_policy_violation · ${ERROR}`;

function setup() {
  const db = makeFakeDb({
    users: [{ _id: USER }],
    conversations: [{
      _id: CONVERSATION, user_id: USER, agent_type: "codex", owner_device_id: "device",
      message_count: 0, updated_at: 1, status: "active", skip_title_generation: true,
    }],
    messages: [], pending_messages: [],
  });
  return {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) },
    scheduler: { runAfter: async () => "scheduled" },
    storage: { getUrl: async () => null },
  } as any;
}

async function ingest(ctx: any, batch: boolean, messages: any[]) {
  if (batch) return (addMessages as any)._handler(ctx, { conversation_id: CONVERSATION, messages });
  for (const message of messages) await (addMessage as any)._handler(ctx, { conversation_id: CONVERSATION, ...message });
}

describe("safety stop survives transcript ingestion and delivery recovery", () => {
  for (const batch of [false, true]) {
    test(`${batch ? "batch" : "single"} ingestion preserves the first stop through later traffic`, async () => {
      const ctx = setup();
      await ingest(ctx, batch, [{ role: "assistant", content: BANNER, timestamp: 10, message_uuid: "first" }]);
      await ingest(ctx, batch, [
        { role: "user", content: '<session-message from="peer">Status update</session-message>', timestamp: 20 },
        { role: "assistant", content: "API Error: 500 temporary failure", timestamp: 30 },
        { role: "assistant", content: BANNER, timestamp: 40, message_uuid: "second" },
        { role: "user", content: "Are you finished?", timestamp: 50 },
      ]);
      expect(await ctx.db.get(CONVERSATION)).toMatchObject({
        pending_api_error: true, pending_api_error_kind: "safety", pending_api_error_at: 10, session_error: BANNER,
      });
      expect(ctx.db._tables.messages.find((row: any) => row.message_uuid === "first")?.content).toBe(BANNER);
    });
  }

  test("a safety failure followed by input within one batch still blocks delivery", async () => {
    const ctx = setup();
    await ingest(ctx, true, [
      { role: "assistant", content: BANNER, timestamp: 10 },
      { role: "user", content: "Follow-up", timestamp: 20 },
    ]);
    expect(await ctx.db.get(CONVERSATION)).toMatchObject({ pending_api_error_kind: "safety", pending_api_error_at: 10 });
  });

  test("the failed-turn error blocks immediately and cannot be cleared or replaced by ordinary writes", async () => {
    const ctx = setup();
    ctx.db._tables.managed_sessions = [{ conversation_id: CONVERSATION, last_heartbeat: Date.now() }];
    await (setSessionError as any)._handler(ctx, { conversation_id: CONVERSATION, error: ERROR });
    const first = { ...await ctx.db.get(CONVERSATION) };
    for (const error of [undefined, "No local checkout", ERROR]) {
      await (setSessionError as any)._handler(ctx, { conversation_id: CONVERSATION, error, force: true });
    }
    expect(await ctx.db.get(CONVERSATION)).toEqual(first);
    expect(first).toMatchObject({ pending_api_error_kind: "safety", session_error: ERROR });
  });

  test("a prior legacy claim is rechecked before the effect; queued text remains visible and retries leave it alone", async () => {
    const ctx = setup();
    const id = await enqueuePendingMessage(ctx, await ctx.db.get(CONVERSATION), USER, { content: "Please review the update" });
    const service = { claimPendingMessageForDelivery: (messageId: string) => claimPendingMessageForDaemon(ctx, messageId as any, USER, "device") };
    await requirePendingDeliveryAdmission(service, id, CONVERSATION);
    await (setSessionError as any)._handler(ctx, { conversation_id: CONVERSATION, error: ERROR, force: true });
    await expect(requirePendingDeliveryAdmission(service, id, CONVERSATION)).rejects.toBeInstanceOf(PendingDeliveryHeldError);
    expect(await collectDeliverableForOwner(ctx, USER, "device")).toEqual([]);
    const before = { ...await ctx.db.get(id) };
    await (retryMessage as any)._handler(ctx, { message_id: id, device_id: "device" });
    expect(await healAndNotifyStuckMessages(ctx, Date.now() + 24 * 60 * 60 * 1000)).toMatchObject({ revived: 0, notified: 0 });
    expect(await ctx.db.get(id)).toEqual(before);
    expect(await (getConversationPendingMessage as any)._handler(ctx, { conversation_id: CONVERSATION }))
      .toMatchObject({ content: "Please review the update", status: "pending", retry_count: 0 });
    const later = await enqueuePendingMessage(ctx, await ctx.db.get(CONVERSATION), USER, { content: "Another update" });
    expect(await claimPendingMessageForDaemon(ctx, later, USER, "device")).toBeNull();
    expect((await ctx.db.get(later)).content).toBe("Another update");
  });

  test("ordinary transient errors still clear when a real turn arrives", async () => {
    const ctx = setup();
    await ingest(ctx, true, [{ role: "assistant", content: "API Error: 500 temporary failure", timestamp: 10 }]);
    await ingest(ctx, true, [{ role: "user", content: "Continue", timestamp: 20 }]);
    expect((await ctx.db.get(CONVERSATION)).pending_api_error).toBe(false);
    const id = await enqueuePendingMessage(ctx, await ctx.db.get(CONVERSATION), USER, { content: "Next task" });
    expect(await claimPendingMessageForDaemon(ctx, id, USER, "device")).not.toBeNull();
  });

  test("legacy error-only state also holds an old cross-user message instead of cancelling it", async () => {
    const ctx = setup();
    await ctx.db.patch(CONVERSATION, { session_error: ERROR });
    const id = await enqueuePendingMessage(ctx, await ctx.db.get(CONVERSATION), "users_sender" as any, { content: "Team update" });
    await ctx.db.patch(id, { created_at: 1, from_conversation_id: "conversations_sender" });
    const before = { ...await ctx.db.get(id) };
    expect(await claimPendingMessageForDaemon(ctx, id, USER, "device")).toBeNull();
    expect(await healAndNotifyStuckMessages(ctx, Date.now())).toMatchObject({ revived: 0, notified: 0, waiting: 1 });
    expect(await ctx.db.get(id)).toEqual(before);
  });

  test("redirecting a parent's message checks the actual child destination", async () => {
    const ctx = setup();
    const child = await ctx.db.insert("conversations", { user_id: USER, pending_api_error_kind: "safety" });
    const id = await enqueuePendingMessage(ctx, await ctx.db.get(CONVERSATION), USER, { content: "Forwarded update" });
    const service = {
      claimPendingMessageForDelivery: (messageId: string, destination?: string) =>
        claimPendingMessageForDaemon(ctx, messageId as any, USER, "device", Date.now(), destination as any),
    };
    await requirePendingDeliveryAdmission(service, id, CONVERSATION);
    await expect(requirePendingDeliveryAdmission(service, id, child)).rejects.toBeInstanceOf(PendingDeliveryHeldError);
    const unrelated = await ctx.db.insert("conversations", { user_id: "users_other" });
    await expect(requirePendingDeliveryAdmission(service, id, unrelated)).rejects.toBeInstanceOf(PendingDeliveryHeldError);
    const normalChild = await ctx.db.insert("conversations", { user_id: USER });
    await requirePendingDeliveryAdmission(service, id, normalChild);
    expect((await ctx.db.get(id)).content).toBe("Forwarded update");
  });
});
