import { describe, expect, test } from "bun:test";
import { heartbeat, updateAgentStatus, reapStaleManagedSessions, performListActiveSessions } from "./managedSessions";
import { makeFakeDb } from "./testDb";

function fixture(overrides: Record<string, unknown> = {}) {
  const db = makeFakeDb({
    users: [{ _id: "owner" }],
    conversations: [{ _id: "conv", user_id: "owner", session_id: "session", has_pending_messages: true }],
    managed_sessions: [{ _id: "managed", user_id: "owner", conversation_id: "conv", session_id: "session", agent_status: "working", agent_status_updated_at: 100, last_heartbeat: 100, ...overrides }],
    pending_messages: [{ _id: "message", conversation_id: "conv", status: "injected" }],
  });
  const scheduled: unknown[] = [];
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|auth-session" }) }, scheduler: { runAfter: async (...args: unknown[]) => { scheduled.push(args); } } };
  const write = (agent_status: string, client_ts?: number, extra = {}) =>
    (updateAgentStatus as any)._handler(ctx, { conversation_id: "conv", agent_status, client_ts, ...extra });
  return { db, ctx, write, scheduled, row: () => db._tables.managed_sessions[0] };
}

describe("hibernation status mutation ordering", () => {
  test("old park cannot restore a stamp after newer wake", async () => {
    const f = fixture({ agent_status: "hibernated", hibernated_at: 100 });
    expect(await f.write("connected", 300, { hibernated_at: null })).toEqual({ applied: true });
    expect(await f.write("hibernated", 200, { hibernated_at: 200 })).toEqual({ applied: false, reason: "stale_status" });
    expect(f.row().agent_status).toBe("connected");
    expect(f.row().hibernated_at).toBeUndefined();
  });

  test("active reassertion advances ordering without resetting dwell time", async () => {
    const f = fixture();
    await f.write("working", 300, { presumed: true });
    expect(f.row().agent_status_updated_at).toBe(100);
    expect(f.row().agent_status_write_at).toBe(300);
    expect((await f.write("hibernated", 200, { hibernated_at: 200 })).applied).toBe(false);
    expect(f.row().agent_status).toBe("working");
    expect(f.row().hibernated_at).toBeUndefined();
  });

  test("stale observed wake changes no payload, heartbeat, schedule or message acknowledgment", async () => {
    const f = fixture();
    await f.write("hibernated", 300, { hibernated_at: 300, permission_mode: "plan", open_tasks: [] });
    const before = structuredClone(f.row());
    expect((await f.write("working", 200, { hibernated_at: null, permission_mode: "default", open_tasks: [{ id: "stale", kind: "background" }] })).applied).toBe(false);
    expect(f.row()).toEqual(before);
    expect(f.db._tables.pending_messages[0].status).toBe("injected");
    expect(f.db._tables.conversations[0].has_pending_messages).toBe(true);
    expect(f.scheduled).toEqual([]);
  });

  test("first applied status wins conflicting equal timestamps; identical retry succeeds", async () => {
    for (const first of ["hibernated", "connected"]) {
      const f = fixture();
      await f.write(first, 300, { hibernated_at: first === "hibernated" ? 300 : null });
      expect((await f.write(first === "hibernated" ? "connected" : "hibernated", 300)).applied).toBe(false);
      expect((await f.write(first, 300)).applied).toBe(true);
      expect(f.row().agent_status).toBe(first);
    }
  });

  test("legacy rows and absent client timestamps remain accepted", async () => {
    const f = fixture({ agent_status_updated_at: undefined });
    expect((await f.write("hibernated", undefined, { hibernated_at: 123 })).applied).toBe(true);
    expect(f.row().hibernated_at).toBe(123);
    expect(f.row().agent_status_write_at).toBeGreaterThan(0);
  });

  test("missing and foreign managed rows do not acknowledge persistence", async () => {
    const f = fixture({ user_id: "other" });
    expect(await f.write("hibernated", 300)).toEqual({ applied: false, reason: "not_owner" });
    f.db._tables.managed_sessions = [];
    expect(await f.write("hibernated", 300)).toEqual({ applied: false, reason: "missing_session" });
  });

  test("heartbeat reassertion participates in ordering without resetting dwell", async () => {
    const f = fixture();
    await (heartbeat as any)._handler(f.ctx, { session_id: "session", agent_status: "working", client_ts: 400 });
    expect(f.row().agent_status_updated_at).toBe(100);
    expect((await f.write("hibernated", 300, { hibernated_at: 300 })).applied).toBe(false);
    await f.write("hibernated", 500, { hibernated_at: 500 });
    await (heartbeat as any)._handler(f.ctx, { session_id: "session", agent_status: "working", client_ts: 450 });
    expect(f.row().agent_status).toBe("hibernated");
    expect(f.row().hibernated_at).toBe(500);
  });

  test("stale reaper preserves intentional parks and drops stopped rows with stale stamps", async () => {
    const f = fixture({ agent_status: "hibernated", hibernated_at: 10, last_heartbeat: Date.now() - 2 * 3600_000 });
    f.db._tables.managed_sessions.push({ _id: "dead", last_heartbeat: Date.now() - 2 * 3600_000, agent_status: "stopped", hibernated_at: 10 });
    expect(await (reapStaleManagedSessions as any)._handler(f.ctx, {})).toEqual({ deleted: 1 });
    expect(f.row()._id).toBe("managed");
    const rows = await performListActiveSessions(f.ctx as any, "owner" as any);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_status: "hibernated", hibernated_at: 10, user_id: "owner" });
  });
});
