// tasks.webListByConversation used to read EVERY task the caller owned and
// filter in JS on the conversation_ids array. Convex cannot index an array for
// containment, so the reverse lookup ("which tasks belong to this session?")
// was a full scan: O(all the caller's tasks) documents deserialized per
// execution, on a live subscription. In production that blew both limits the
// 1s cap measures — user JS time on bytes moved, and the system-operation
// budget (Sentry JAVASCRIPT-REACT-5K and -5F).
//
// These tests pin the replacement: the answer comes from three bounded
// indexes (the entity_conversations rail, tasks.by_created_from_conversation,
// conversations.active_task_id), and the number of task documents the handler
// touches does not grow with how many tasks the caller owns.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { webListByConversation } from "./tasks";

const OWNER = "users_owner";
const CONV = "conversations_target";
const OTHER_CONV = "conversations_other";

// Counts the task documents a handler materializes — the quantity the two
// production limits are actually spent on.
function countingDb(tables: Record<string, any[]>) {
  const db = makeFakeDb(tables);
  const stats = { taskDocs: 0 };
  const isTask = (row: any) => row && row.short_id?.startsWith?.("ct-");
  const tally = (rows: any[]) => { for (const r of rows) if (isTask(r)) stats.taskDocs++; };
  const rawQuery = db.query.bind(db);
  const rawGet = db.get.bind(db);
  db.query = (table: string) => {
    const b = rawQuery(table);
    const collect = b.collect.bind(b);
    const take = b.take.bind(b);
    b.collect = async () => { const r = await collect(); tally(r); return r; };
    b.take = async (n: number) => { const r = await take(n); tally(r); return r; };
    return b;
  };
  db.get = async (id: any) => { const doc = await rawGet(id); if (isTask(doc)) stats.taskDocs++; return doc; };
  return { db, stats };
}

function seed(over: Partial<Record<string, any[]>> = {}, noiseTasks = 0) {
  const tasks: any[] = [];
  for (let i = 0; i < noiseTasks; i++) {
    tasks.push({
      _id: `tasks_noise_${i}`, short_id: `ct-n${i}`, title: `noise ${i}`,
      user_id: OWNER, status: "open", source: "agent", created_at: i,
      // The bytes the old scan paid for on every execution.
      description: "x".repeat(200),
    });
  }
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    tasks,
    entity_conversations: [],
    team_memberships: [],
    conversations: [
      { _id: CONV, user_id: OWNER, is_private: true, status: "active" },
      { _id: OTHER_CONV, user_id: OWNER, is_private: true, status: "active" },
    ],
    ...over,
  };
  if (over.tasks) tables.tasks = [...tasks, ...over.tasks];
  const { db, stats } = countingDb(tables);
  const ctx = {
    auth: { async getUserIdentity() { return { subject: `${OWNER}|session` }; } },
    db,
  } as any;
  return { ctx, tables, stats };
}

const run = (ctx: any) => (webListByConversation as any)._handler(ctx, { conversationId: CONV });

const linkedTask = (id: string, shortId: string, over: any = {}) => ({
  _id: id, short_id: shortId, title: shortId, user_id: OWNER,
  status: "open", source: "agent", created_at: 1, ...over,
});

describe("tasks.webListByConversation", () => {
  test("returns the task the association rail points at", async () => {
    const { ctx } = seed({
      tasks: [linkedTask("tasks_linked", "ct-1", { conversation_ids: [CONV] })],
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_linked",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    });
    expect(await run(ctx)).toEqual([
      { _id: "tasks_linked", short_id: "ct-1", title: "ct-1", status: "open", external: undefined },
    ]);
  });

  test("returns a pre-rail task through created_from_conversation", async () => {
    const { ctx } = seed({
      tasks: [linkedTask("tasks_origin", "ct-2", {
        conversation_ids: [CONV], created_from_conversation: CONV,
      })],
    });
    expect((await run(ctx)).map((t: any) => t._id)).toEqual(["tasks_origin"]);
  });

  test("returns the task the session is actively working", async () => {
    const { ctx } = seed({
      tasks: [linkedTask("tasks_active", "ct-3", { conversation_ids: [CONV] })],
      conversations: [
        { _id: CONV, user_id: OWNER, is_private: true, status: "active", active_task_id: "tasks_active" },
        { _id: OTHER_CONV, user_id: OWNER, is_private: true, status: "active" },
      ],
    });
    expect((await run(ctx)).map((t: any) => t._id)).toEqual(["tasks_active"]);
  });

  test("a task reached by two of the three sources is returned once", async () => {
    const { ctx } = seed({
      tasks: [linkedTask("tasks_both", "ct-4", {
        conversation_ids: [CONV], created_from_conversation: CONV,
      })],
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_both",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    });
    expect(await run(ctx)).toHaveLength(1);
  });

  test("another conversation's task is not returned", async () => {
    const { ctx } = seed({
      tasks: [linkedTask("tasks_elsewhere", "ct-5", {
        conversation_ids: [OTHER_CONV], created_from_conversation: OTHER_CONV,
      })],
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_elsewhere",
        conversation_id: OTHER_CONV, relationship: "work", created_at: 1,
      }],
    });
    expect(await run(ctx)).toEqual([]);
  });

  test("a rail row pointing at a deleted task is skipped, not thrown on", async () => {
    const { ctx } = seed({
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_gone",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    });
    expect(await run(ctx)).toEqual([]);
  });

  test("a plan link on the same conversation is ignored", async () => {
    const { ctx } = seed({
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "plan", entity_id: "plans_1",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    });
    expect(await run(ctx)).toEqual([]);
  });

  test("a conversation the caller cannot open yields nothing", async () => {
    const { ctx, tables } = seed({
      tasks: [linkedTask("tasks_linked", "ct-1", { conversation_ids: [CONV] })],
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_linked",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    });
    // Hand the session to a stranger, keeping it private.
    tables.conversations[0].user_id = "users_stranger";
    expect(await run(ctx)).toEqual([]);
  });

  test("task documents read stay flat as the caller's task count grows", async () => {
    const link = {
      tasks: [linkedTask("tasks_linked", "ct-1", { conversation_ids: [CONV] })],
      entity_conversations: [{
        _id: "ec_1", user_id: OWNER, entity_type: "task", entity_id: "tasks_linked",
        conversation_id: CONV, relationship: "work", created_at: 1,
      }],
    };
    const small = seed(link, 50);
    const large = seed(link, 5000);
    expect(await run(small.ctx)).toHaveLength(1);
    expect(await run(large.ctx)).toHaveLength(1);
    // The old implementation read 51 and 5001 task documents here.
    expect(small.stats.taskDocs).toBe(large.stats.taskDocs);
    expect(large.stats.taskDocs).toBeLessThan(5);
  });
});
