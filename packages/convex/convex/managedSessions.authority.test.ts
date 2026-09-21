import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { registerManagedSession, updateSessionConversation, getPendingMessagesForSession, markMessageDelivered, updateAgentStatus, updateManagedSessionId, heartbeat, heartbeatBatch } from "./managedSessions";

const CALLER = "caller";
const OTHER = "other";
function fixture(runner = OTHER) {
  const db = makeFakeDb({
    conversations: [{ _id: "conv", session_id: "target", user_id: runner, owner_user_id: CALLER, team_id: "team", is_private: false, has_pending_messages: true }],
    managed_sessions: [{ _id: "managed", user_id: OTHER, conversation_id: "conv", session_id: "target", last_heartbeat: 0, pid: 1 }],
    devices: [{ _id: "dev", user_id: CALLER, device_id: "device", last_seen: Date.now() }],
    session_owners: [{ _id: "owner", user_id: CALLER, conversation_id: "conv" }],
    team_memberships: [{ _id: "membership", team_id: "team", user_id: CALLER }],
    pending_messages: [{ _id: "message", conversation_id: "conv", status: "pending", content: "private prompt" }],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${CALLER}|session` }) }, scheduler: { runAfter: async () => null } } as any;
}
function unchanged(ctx: any) {
  expect(ctx.db._patched).toEqual([]);
  expect(ctx.db._inserted).toEqual([]);
  expect(ctx.db._deleted).toEqual([]);
}

describe("managed session execution authority", () => {
  for (const session_id of ["new", "target"]) {
    for (const withDevice of [false, true]) {
      test(`foreign ${session_id} registration with device=${withDevice} has no effects`, async () => {
        const ctx = fixture();
        const result = await (registerManagedSession as any)._handler(ctx, {
          session_id, conversation_id: "conv", pid: 2, ...(withDevice ? { device_id: "device" } : {}),
        });
        expect(result.notOwner).toBe(true);
        unchanged(ctx);
      });
    }
  }
  test("omitting the conversation cannot reclaim a stale foreign registration", async () => {
    const ctx = fixture();
    expect((await (registerManagedSession as any)._handler(ctx, { session_id: "target", pid: 2 })).notOwner).toBe(true);
    unchanged(ctx);
  });
  test("a caller-owned target cannot disguise a foreign source session", async () => {
    const ctx = fixture();
    ctx.db._tables.conversations.push({ _id: "mine", user_id: CALLER, session_id: "mine" });
    expect((await (registerManagedSession as any)._handler(ctx, { session_id: "target", conversation_id: "mine", pid: 2 })).notOwner).toBe(true);
    unchanged(ctx);
  });
  test("an unknown caller device is refused before cleanup", async () => {
    const ctx = fixture(CALLER);
    await expect((registerManagedSession as any)._handler(ctx, { session_id: "new", conversation_id: "conv", pid: 2, device_id: "foreign" })).rejects.toThrow("device");
    unchanged(ctx);
  });
  test("explicit runner transfer permits fresh-row takeover", async () => {
    const ctx = fixture(CALLER);
    ctx.db._tables.managed_sessions[0].last_heartbeat = Date.now();
    await (registerManagedSession as any)._handler(ctx, { session_id: "target", conversation_id: "conv", pid: 2, device_id: "device" });
    expect(ctx.db._tables.managed_sessions).toHaveLength(1);
    expect(ctx.db._tables.managed_sessions[0].user_id).toBe(CALLER);
  });
  test("relink checks the destination before deleting its registration", async () => {
    const ctx = fixture();
    ctx.db._tables.managed_sessions.push({ _id: "own", session_id: "own", user_id: CALLER });
    await expect((updateSessionConversation as any)._handler(ctx, { session_id: "own", conversation_id: "conv" })).rejects.toThrow("Unauthorized");
    unchanged(ctx);
  });
  test("a revoked runner cannot read prompts through its old registration", async () => {
    const ctx = fixture();
    ctx.db._tables.managed_sessions[0].user_id = CALLER;
    await expect((getPendingMessagesForSession as any)._handler(ctx, { session_id: "target" })).rejects.toThrow("Unauthorized");
    unchanged(ctx);
  });
  test("a foreign pending ID cannot be acknowledged", async () => {
    const ctx = fixture();
    await expect((markMessageDelivered as any)._handler(ctx, { message_id: "message" })).rejects.toThrow("Unauthorized");
    unchanged(ctx);
  });
  test("revoked status reporting cannot acknowledge injected messages", async () => {
    const ctx = fixture();
    ctx.db._tables.managed_sessions[0].user_id = CALLER;
    ctx.db._tables.pending_messages[0].status = "injected";
    ctx.db._tables.pending_messages[0].paste_verified_at = Date.now();
    expect(await (updateAgentStatus as any)._handler(ctx, { conversation_id: "conv", agent_status: "working" })).toEqual({ applied: false, reason: "not_owner" });
    unchanged(ctx);
  });
  test("the current runner reads and acknowledges its prompt", async () => {
    const ctx = fixture(CALLER);
    ctx.db._tables.managed_sessions[0].user_id = CALLER;
    expect(await (getPendingMessagesForSession as any)._handler(ctx, { session_id: "target" })).toHaveLength(1);
    expect(await (markMessageDelivered as any)._handler(ctx, { message_id: "message" })).toEqual({ success: true });
    expect(ctx.db._tables.pending_messages[0].status).toBe("delivered");
    expect(ctx.db._tables.conversations[0].has_pending_messages).toBe(false);
  });
});


describe("managed session identity and liveness", () => {
  test("a foreign session ID cannot be adopted by renaming an owned row", async () => {
    const ctx = fixture();
    ctx.db._tables.managed_sessions.push({ _id: "own", session_id: "own", user_id: CALLER });
    await expect((updateManagedSessionId as any)._handler(ctx, { old_session_id: "own", new_session_id: "target" })).rejects.toThrow("already registered");
    unchanged(ctx);
  });
  test("a revoked runner cannot renew or trigger effects through heartbeat", async () => {
    const ctx = fixture();
    ctx.db._tables.managed_sessions[0].user_id = CALLER;
    expect(await (heartbeat as any)._handler(ctx, { session_id: "target", agent_status: "working" })).toEqual({ found: false });
    expect(await (heartbeatBatch as any)._handler(ctx, { sessions: [{ session_id: "target", agent_status: "working" }] })).toEqual({ updated: 0 });
    unchanged(ctx);
  });
  test("a runner can relink and rotate its own session ID", async () => {
    const ctx = fixture(CALLER);
    ctx.db._tables.managed_sessions[0].user_id = CALLER;
    await (updateSessionConversation as any)._handler(ctx, { session_id: "target", conversation_id: "conv" });
    expect(await (updateManagedSessionId as any)._handler(ctx, { old_session_id: "target", new_session_id: "resumed" })).toEqual({ found: true, updated: true });
    expect(ctx.db._tables.conversations[0].session_id).toBe("resumed");
    expect(ctx.db._tables.managed_sessions[0].session_id).toBe("resumed");
  });
});
