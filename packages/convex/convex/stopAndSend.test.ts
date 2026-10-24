import { describe, expect, test } from "bun:test";
import { stopAndSendForUser } from "./daemonCommandUtils";
import { updateAgentStatus } from "./managedSessions";
import { makeFakeDb } from "./testDb";

// In-memory db in the shape pendingMessages.sharedQueue.test.ts uses: index
// names ignored, eq constraints matched.
type Rec = Record<string, any>;
function world(agentStatus: string | undefined) {
  const tables: Record<string, Rec[]> = {
    users: [{ _id: "uAnn", name: "Ann" }],
    conversations: [{ _id: "c1", user_id: "uAnn", workspace: "user:uAnn", is_private: true, short_id: "jxc1", status: "active", owner_device_id: "dev1" }],
    managed_sessions: agentStatus ? [{ _id: "ms1", conversation_id: "c1", agent_status: agentStatus }] : [],
    pending_messages: [],
    daemon_commands: [],
    team_memberships: [],
    doc_presence: [],
  };
  let n = 0;
  const all = () => Object.values(tables).flat();
  const db = {
    async get(id: string) { return all().find((r) => r._id === id) ?? null; },
    async insert(table: string, doc: Rec) { const _id = `${table}_${++n}`; (tables[table] ??= []).push({ _id, ...doc }); return _id; },
    async patch(id: string, patch: Rec) { Object.assign(all().find((r) => r._id === id)!, patch); },
    query(table: string) {
      const cs: Array<{ f: string; v: any }> = [];
      const q: any = { eq(f: string, v: any) { cs.push({ f, v }); return q; }, gt() { return q; } };
      const run = () => (tables[table] ?? []).filter((r) => cs.every((c) => String(r[c.f]) === String(c.v)));
      const chain = {
        withIndex(_: string, b: (q: any) => unknown) { b(q); return chain; },
        filter() { return chain; },
        order() { return chain; },
        async collect() { return run(); },
        async first() { return run()[0] ?? null; },
        async unique() { return run()[0] ?? null; },
        async take(k: number) { return run().slice(0, k); },
      };
      return chain;
    },
  };
  return { ctx: { db }, tables };
}

describe("stop and send", () => {
  test("a running turn: the message waits queued and the daemon is told to stop, releasing on no turn", async () => {
    const { ctx, tables } = world("working");
    const out = await stopAndSendForUser(ctx, "uAnn" as any, "c1" as any, "do this instead", "cl1", 1000, "req1");
    expect(out).toEqual({ interrupted: true });
    expect(tables.pending_messages).toHaveLength(1);
    expect(tables.pending_messages[0]).toMatchObject({ content: "do this instead", client_id: "cl1", status: "held", queued: true });
    expect(tables.daemon_commands).toHaveLength(1);
    const cmd = tables.daemon_commands[0];
    expect(cmd).toMatchObject({ command: "escape", user_id: "uAnn", request_id: "req1", target_device_id: "dev1" });
    expect(JSON.parse(cmd.args)).toEqual({ conversation_id: "c1", pressed_at: 1000, release_queued: true });
  });

  test("a turn stopped at a permission prompt is still a turn to stop", async () => {
    const { ctx, tables } = world("permission_blocked");
    expect(await stopAndSendForUser(ctx, "uAnn" as any, "c1" as any, "x", "cl1", 1000)).toEqual({ interrupted: true });
    expect(tables.pending_messages[0].status).toBe("held");
  });

  test("a session at rest: nothing to stop, the message goes as a plain send", async () => {
    const { ctx, tables } = world("idle");
    expect(await stopAndSendForUser(ctx, "uAnn" as any, "c1" as any, "x", "cl1", 1000)).toEqual({ interrupted: false });
    expect(tables.pending_messages[0].status).toBe("pending");
    expect(tables.daemon_commands).toHaveLength(0);
  });

  test("only someone who may command the session can stop it", async () => {
    const { ctx, tables } = world("working");
    await expect(stopAndSendForUser(ctx, "uBob" as any, "c1" as any, "x", "cl1", 1000)).rejects.toThrow("Not authorized");
    expect(tables.pending_messages).toHaveLength(0);
    expect(tables.daemon_commands).toHaveLength(0);
  });
});

// The interrupted turn's settle is what lets the queued row go. A turn stopped
// at a permission prompt settles from permission_blocked, which is not an
// active status, so that transition releases the queue on its own terms.
describe("a stopped turn releases the queue", () => {
  function fixture(agent_status: string) {
    const db = makeFakeDb({
      users: [{ _id: "owner" }],
      conversations: [{ _id: "conv", user_id: "owner", session_id: "session" }],
      managed_sessions: [{ _id: "managed", user_id: "owner", conversation_id: "conv", session_id: "session", agent_status, agent_status_updated_at: 100, last_heartbeat: 100 }],
      pending_messages: [{ _id: "pm1", conversation_id: "conv", from_user_id: "owner", owner_user_id: "owner", content: "instead", created_at: 1, status: "held", queued: true, retry_count: 0 }],
    });
    const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|auth-session" }) }, scheduler: { runAfter: async () => {} } };
    const write = (status: string, client_ts: number) =>
      (updateAgentStatus as any)._handler(ctx, { conversation_id: "conv", agent_status: status, client_ts });
    return { write, row: () => db._tables.pending_messages[0] };
  }

  test("working to idle", async () => {
    const f = fixture("working");
    await f.write("idle", 300);
    expect(f.row().status).toBe("pending");
  });

  test("permission prompt to idle", async () => {
    const f = fixture("permission_blocked");
    await f.write("idle", 300);
    expect(f.row().status).toBe("pending");
  });

  test("a prompt answered and the turn going on keeps it queued", async () => {
    const f = fixture("permission_blocked");
    await f.write("working", 300);
    expect(f.row().status).toBe("held");
  });
});
