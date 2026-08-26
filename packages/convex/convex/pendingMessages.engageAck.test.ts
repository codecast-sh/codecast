import { describe, expect, test } from "bun:test";
import { performSessionSend, enqueuePendingMessage } from "./pendingMessages";

// Replying in a thread you were handed must retire your unacked "assigned to
// you" ping (ackAssignmentOnEngage at the enqueue choke point). Without this,
// the inbox pill and the in-conversation banner outlive the assignee's actual
// engagement — pings sat unacked for days on threads the assignee had already
// answered. Machine-origin injections (trigger scheduler) must NOT ack: nobody
// saw anything.

type Rec = Record<string, any>;

function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((r) => ({ ...r }));
  const allRows = () => Object.values(tables).flat();
  const db = {
    async get(id: string) { return allRows().find((r) => r._id === id) ?? null; },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    query(table: string) {
      const constraints: Array<{ field: string; op: "eq" | "gt"; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) { constraints.push({ field, op: "eq", val }); return q; },
        gt(field: string, val: any) { constraints.push({ field, op: "gt", val }); return q; },
      };
      const run = () => (tables[table] ?? []).filter((r) =>
        constraints.every((c) => c.op === "eq" ? String(r[c.field]) === String(c.val) : (r[c.field] ?? -Infinity) > c.val));
      const chain = {
        withIndex(_name: string, builder: (q: any) => unknown) { builder(q); return chain; },
        filter(_fn: any) { return chain; },
        async collect() { return run(); },
        async first() { return run()[0] ?? null; },
        async take(n: number) { return run().slice(0, n); },
      };
      return chain;
    },
  };
  return { ctx: { db }, tables };
}

function world() {
  const now = Date.now();
  return createDb({
    users: [{ _id: "uBot", is_bot: true }, { _id: "uAsh" }],
    teams: [{ _id: "tA" }],
    team_memberships: [
      { _id: "mBot", user_id: "uBot", team_id: "tA", visibility: "summary" },
      { _id: "mAsh", user_id: "uAsh", team_id: "tA", visibility: "summary" },
    ],
    conversations: [
      // The bot runs the session; it handed ownership to Ash (unacked ping).
      { _id: "convBot", user_id: "uBot", owner_user_id: "uAsh", team_id: "tA", short_id: "jxbot01", session_id: "sess-bot", is_private: false, status: "active" },
    ],
    session_owners: [
      { _id: "soAsh", conversation_id: "convBot", user_id: "uAsh", added_by: "uBot", added_at: now - 60_000 },
    ],
    pending_messages: [],
  });
}

describe("engage-ack: a reply from the assignee retires the handoff ping", () => {
  test("performSessionSend by the assignee stamps seen_at", async () => {
    const { ctx, tables } = world();
    await performSessionSend(ctx as any, "uAsh" as any, { to: "jxbot01", body: "on it" });
    expect(tables.pending_messages).toHaveLength(1);
    expect(tables.session_owners[0].seen_at).toBeGreaterThan(0);
  });

  test("a scheduler-origin injection does not ack", async () => {
    const { ctx, tables } = world();
    const conv = tables.conversations[0];
    await enqueuePendingMessage(ctx as any, conv, "uAsh" as any, {
      content: "triggered run",
      origin: "scheduler",
    });
    expect(tables.session_owners[0].seen_at).toBeUndefined();
  });

  test("a legacy self-added row without seen_at stays untouched", async () => {
    const { ctx, tables } = world();
    tables.session_owners[0].added_by = "uAsh"; // self-claim missing its pre-ack stamp
    await performSessionSend(ctx as any, "uAsh" as any, { to: "jxbot01", body: "note to self" });
    expect(tables.session_owners[0].seen_at).toBeUndefined();
  });

  test("a sender without an owner row is a no-op", async () => {
    const { ctx, tables } = world();
    await performSessionSend(ctx as any, "uBot" as any, { to: "jxbot01", body: "bot turn" });
    expect(tables.session_owners).toHaveLength(1);
    expect(tables.session_owners[0].seen_at).toBeUndefined();
  });
});
