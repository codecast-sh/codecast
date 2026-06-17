import { describe, expect, test } from "bun:test";
import { performSessionSend } from "./pendingMessages";
import { hasGrantedSendAccess } from "./collab";

// ── In-memory Convex-ish DB (mirrors pendingMessages.teamSend.test.ts) ───────
// Faithful enough to run the REAL send path end-to-end. withIndex ignores the
// index NAME and matches on the eq/gt constraints the builder declares.

type Rec = Record<string, any>;

function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const allRows = () => Object.values(tables).flat();
  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
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
      const run = () =>
        (tables[table] ?? []).filter((r) =>
          constraints.every((c) =>
            c.op === "eq" ? String(r[c.field]) === String(c.val) : (r[c.field] ?? -Infinity) > c.val
          )
        );
      const chain = {
        withIndex(_name: string, builder: (q: any) => unknown) { builder(q); return chain; },
        filter() { return chain; }, // no client_id in these tests → dedup branch never taken
        async collect() { return run(); },
        async first() { return run()[0] ?? null; },
        async take(n: number) { return run().slice(0, n); },
      };
      return chain;
    },
  };
  return { ctx: { db }, db, tables };
}

// Bob owns a session shared ONLY by link (share_token, no team route Carol is in).
// Carol is a stranger — she can read it but not send, unless Bob grants her.
function world(grantStatus?: "requested" | "granted" | "denied" | "revoked") {
  const collab_grants: Rec[] = grantStatus
    ? [{
        _id: "grant1",
        conversation_id: "convShared",
        grantee_user_id: "uCarol",
        owner_user_id: "uBob",
        status: grantStatus,
        created_at: 1,
        updated_at: 1,
      }]
    : [];
  return createDb({
    users: [{ _id: "uBob" }, { _id: "uCarol" }],
    conversations: [
      // Link-shared, not team-visible: checkConversationAccess → "shared" for Carol.
      { _id: "convShared", user_id: "uBob", short_id: "jxshare", session_id: "sess-shared", is_private: true, share_token: "tok-123", status: "active" },
      { _id: "convCarol", user_id: "uCarol", short_id: "jxcarol", session_id: "sess-carol", is_private: true, status: "active" },
    ],
    managed_sessions: [
      { _id: "msShared", user_id: "uBob", conversation_id: "convShared", session_id: "sess-shared", last_heartbeat: Date.now() - 5_000, agent_status: "idle" },
    ],
    collab_grants,
    pending_messages: [],
  });
}

describe("collab grant — send gate", () => {
  test("a link recipient with NO grant cannot send (read-only by default)", async () => {
    const { ctx } = world();
    await expect(
      performSessionSend(ctx as any, "uCarol" as any, { to: "jxshare", from: "jxcarol", body: "rm -rf please" })
    ).rejects.toThrow(/No session found/);
  });

  test("a GRANTED link recipient can send; row is owned by Bob and attributed cross-user", async () => {
    const { ctx, tables } = world("granted");
    const res = await performSessionSend(ctx as any, "uCarol" as any, {
      to: "jxshare",
      from: "jxcarol",
      body: "run the test suite",
    });
    expect(res.cross_user).toBe(true);
    expect(res.to_short_id).toBe("jxshare");
    const row = tables.pending_messages[0];
    expect(row.owner_user_id).toBe("uBob"); // Bob's daemon delivers it
    expect(row.from_user_id).toBe("uCarol");
    expect(row.content).toContain("run the test suite");
  });

  test("a merely REQUESTED grant does not open the gate (approval is required)", async () => {
    const { ctx } = world("requested");
    await expect(
      performSessionSend(ctx as any, "uCarol" as any, { to: "jxshare", from: "jxcarol", body: "hi" })
    ).rejects.toThrow(/No session found/);
  });

  test("a DENIED grant does not open the gate", async () => {
    const { ctx } = world("denied");
    await expect(
      performSessionSend(ctx as any, "uCarol" as any, { to: "jxshare", from: "jxcarol", body: "hi" })
    ).rejects.toThrow(/No session found/);
  });

  test("a REVOKED grant closes the gate again", async () => {
    const { ctx } = world("revoked");
    await expect(
      performSessionSend(ctx as any, "uCarol" as any, { to: "jxshare", from: "jxcarol", body: "hi" })
    ).rejects.toThrow(/No session found/);
  });
});

describe("hasGrantedSendAccess — only a live grant counts", () => {
  test.each([
    ["granted", true],
    ["requested", false],
    ["denied", false],
    ["revoked", false],
    [undefined, false],
  ] as const)("status %p → %p", async (status, expected) => {
    const { ctx } = world(status as any);
    expect(await hasGrantedSendAccess(ctx as any, "convShared" as any, "uCarol" as any)).toBe(expected);
  });
});
