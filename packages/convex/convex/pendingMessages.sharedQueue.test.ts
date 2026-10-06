import { describe, expect, test } from "bun:test";
import { headOfEachQueue, mergeQueuedForUser, reorderQueuedForUser, performSessionSend } from "./pendingMessages";
import { queueAtBefore } from "./lib/sessionQueue";
import { formatJointMessage, parseJointMessage } from "@codecast/shared/contracts/jointMessage";

// In-memory db in the shape pendingMessages.collabGrant.test.ts uses: index
// names ignored, eq constraints matched.
type Rec = Record<string, any>;
function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
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
        async collect() { return run(); },
        async first() { return run()[0] ?? null; },
        async take(k: number) { return run().slice(0, k); },
      };
      return chain;
    },
  };
  return { ctx: { db }, tables };
}

// Ann owns the session; Bob is on her team (team-visible), so both may send.
function world(rows: Rec[]) {
  return createDb({
    users: [{ _id: "uAnn", name: "Ann" }, { _id: "uBob", name: "Bob" }],
    teams: [{ _id: "t1" }],
    team_memberships: [{ _id: "m1", team_id: "t1", user_id: "uAnn" }, { _id: "m2", team_id: "t1", user_id: "uBob" }],
    conversations: [{ _id: "c1", user_id: "uAnn", team_id: "t1", workspace: "team:t1", is_private: false, team_visibility: "full", short_id: "jxc1", status: "active" }],
    pending_messages: rows,
    doc_presence: [],
  });
}
const row = (id: string, from: string, content: string, created_at: number, status = "pending") =>
  ({ _id: id, conversation_id: "c1", from_user_id: from, owner_user_id: "uAnn", content, created_at, status, retry_count: 0 });

describe("queue order", () => {
  test("a moved row's queue_at decides which row the daemon takes first", () => {
    const rows = [row("a", "uAnn", "one", 1), row("b", "uBob", "two", 2)];
    expect(headOfEachQueue(rows)[0]._id).toBe("a");
    (rows[1] as any).queue_at = queueAtBefore([rows[0]], "a")!;
    expect(headOfEachQueue(rows)[0]._id).toBe("b");
  });

  test("nothing jumps ahead of a row the session is already taking", () => {
    expect(queueAtBefore([row("a", "uAnn", "x", 1, "injected")], "a")).toBeNull();
  });
});

describe("reorderQueuedForUser", () => {
  test("a teammate moves the last message to the front", async () => {
    const { ctx, tables } = world([row("a", "uAnn", "one", 1), row("b", "uAnn", "two", 2), row("c", "uBob", "three", 3)]);
    expect(await reorderQueuedForUser(ctx as any, "uBob" as any, "c1" as any, { messageId: "c", beforeId: "a" })).toBe("moved");
    expect(headOfEachQueue(tables.pending_messages)[0]._id).toBe("c");
  });

  test("a message being delivered does not move", async () => {
    const { ctx } = world([row("a", "uAnn", "one", 1, "injected"), row("b", "uAnn", "two", 2)]);
    expect(await reorderQueuedForUser(ctx as any, "uAnn" as any, "c1" as any, { messageId: "a", beforeId: null })).toBe("not_waiting");
  });
});

describe("mergeQueuedForUser", () => {
  test("two people's messages become one turn naming each, in queue order", async () => {
    const { ctx, tables } = world([row("a", "uAnn", "fix the header", 1), row("b", "uBob", '<user-message from="Bob">\nalso mobile\n</user-message>', 2)]);
    expect(await mergeQueuedForUser(ctx as any, "uBob" as any, "c1" as any, { messageId: "b", intoId: "a" })).toBe("merged");
    const [a, b] = tables.pending_messages;
    expect(parseJointMessage(a.content)).toEqual([{ from: "Ann", body: "fix the header" }, { from: "Bob", body: "also mobile" }]);
    expect(b.status).toBe("cancelled");
    expect(b.merged_into).toBe("a");
  });
});

describe("send together from a collaborator", () => {
  const joint = formatJointMessage([{ from: "Bob", body: "ship it" }, { from: "Ann", body: "after the tests" }]);

  test("goes out as written when the other part is Ann's live draft", async () => {
    const { ctx, tables } = world([]);
    tables.doc_presence.push({ _id: "p1", doc_id: "compose:c1", user_id: "uAnn", user_name: "Ann", draft_text: "after the tests ", updated_at: Date.now() });
    await performSessionSend(ctx as any, "uBob" as any, { to: "jxc1", body: joint, direct: true });
    expect(tables.pending_messages[0].content).toBe(joint);
  });

  test("a part naming someone who did not write it is wrapped as the sender's own words", async () => {
    const { ctx, tables } = world([]);
    await performSessionSend(ctx as any, "uBob" as any, { to: "jxc1", body: joint, direct: true });
    const content = tables.pending_messages[0].content;
    expect(content.startsWith('<user-message from="Bob">')).toBe(true);
    expect(parseJointMessage(content)).toBeNull();
  });
});
