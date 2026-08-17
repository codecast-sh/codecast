import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";
import { performSessionSend } from "./pendingMessages";

// The web poll card (AskUserQuestionBlock) and the inline composer send through the
// store's `sendMessage` action → dispatch.sendMessage. CollabComposer sends the same
// intent through pendingMessages.sendSessionMessage. Both must apply ONE authorization
// rule (canSendProductMessage): a teammate who may send into a team-shared session from
// the composer must be able to answer its poll too. This pins the dispatch path against
// the rule the composer path already enforces.

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
    // Bob's session is already assigned to Dave (owner_user_id), as a Mr Bot session
    // parked on a founder would be — so a teammate's send never auto-owns it.
    users: [{ _id: "uAlice" }, { _id: "uBob" }, { _id: "uCarol" }, { _id: "uDave" }],
    teams: [{ _id: "tA" }],
    team_memberships: [
      { _id: "mAlice", user_id: "uAlice", team_id: "tA", visibility: "summary" },
      { _id: "mBob", user_id: "uBob", team_id: "tA", visibility: "summary" },
    ],
    conversations: [
      { _id: "convBob", user_id: "uBob", owner_user_id: "uDave", team_id: "tA", short_id: "jxbob01", session_id: "sess-bob", is_private: false, status: "active" },
      { _id: "convBobPriv", user_id: "uBob", team_id: "tA", short_id: "jxbobpv", session_id: "sess-bobpv", is_private: true, status: "active" },
    ],
    managed_sessions: [
      { _id: "msBob", user_id: "uBob", conversation_id: "convBob", session_id: "sess-bob", last_heartbeat: now - 5_000, agent_status: "idle" },
    ],
    pending_messages: [],
  });
}

const POLL = JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Teach me first" });

// Runs the real dispatch mutation handler as `userId` (the store's sendMessage action
// arrives here as { action: "sendMessage", args: [convId, content, imageIds, clientId] }).
function sendAs(ctx: any, userId: string, convId: string, clientId: string) {
  return (dispatch as any)._handler(
    { ...ctx, auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) } },
    { action: "sendMessage", args: [convId, POLL, undefined, clientId] },
  );
}

describe("dispatch.sendMessage — same send rule as the composer", () => {
  test("a teammate who can send from the composer can answer a poll in the same session", async () => {
    const { ctx, tables } = world();
    // Composer path (CollabComposer → sendSessionMessage) admits Alice.
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", body: "hello" });
    expect(tables.pending_messages).toHaveLength(1);

    // Poll path (AskUserQuestionBlock → store.sendMessage → dispatch.sendMessage) must too.
    await sendAs(ctx, "uAlice", "convBob", "poll-1");
    const row = tables.pending_messages[1];
    expect(row.content).toBe(POLL);
    expect(row.from_user_id).toBe("uAlice");
    expect(row.owner_user_id).toBe("uBob"); // delivery still routes to the runner's daemon
  });

  test("a stranger and a private-session teammate stay refused", async () => {
    const { ctx } = world();
    await expect(sendAs(ctx, "uCarol", "convBob", "poll-2"))
      .rejects.toThrow(/Unauthorized/);
    await expect(sendAs(ctx, "uAlice", "convBobPriv", "poll-3"))
      .rejects.toThrow(/Unauthorized/);
  });
});
