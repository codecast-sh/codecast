// The retroactive membership sweep: legacy entity_subscriptions rows get a
// via stamp from the measured heuristics, task thread_reads rows survive only
// for participants under taskThreadParticipants, and rows pointing at deleted
// tasks go away. Dry run counts the same world a live run would leave behind
// and writes nothing.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { sweepPage, sweep } from "./threadMembershipSweep";

const ASHOT = "users_ashot";
const BOB = "users_bob";
const CAROL = "users_carol";

function makeCtx(over: Partial<Record<string, any[]>> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: ASHOT, name: "Ashot Petrosian", email: "ashot@codecast.sh", github_username: "ashot" },
      { _id: BOB, name: "Bob Jones", email: "bob@codecast.sh" },
      { _id: CAROL, name: "Carol Reed", email: "carol@codecast.sh" },
    ],
    tasks: [
      { _id: "tasks_agent", user_id: ASHOT, source: "agent", status: "open" },
      { _id: "tasks_human", user_id: ASHOT, source: "human", status: "open" },
      { _id: "tasks_promoted", user_id: ASHOT, source: "agent", promoted: true, status: "open" },
    ],
    task_comments: [],
    entity_subscriptions: [],
    thread_reads: [],
    ...over,
  };
  const db = makeFakeDb(tables);
  return { ctx: { db } as any, tables, db };
}

let nextId = 0;
const sub = (userId: string, taskId: string, reason: string, over: any = {}) => ({
  _id: `entity_subscriptions_seed${++nextId}`,
  user_id: userId,
  entity_type: "task",
  entity_id: taskId,
  reason,
  muted: false,
  created_at: 1,
  ...over,
});
const read = (userId: string, taskId: string) => ({
  _id: `thread_reads_seed${++nextId}`,
  user_id: userId,
  kind: "task",
  root_key: taskId,
  task_id: taskId,
  last_activity_at: 1,
  last_read_at: 0,
  updated_at: 1,
});
const comment = (taskId: string, author: string, over: any = {}) => ({
  _id: `task_comments_seed${++nextId}`,
  task_id: taskId,
  author,
  text: "x",
  comment_type: "note",
  created_at: 1,
  ...over,
});

const subs = async (args: any = {}) =>
  (sweepPage as any)._handler(args.ctx.ctx, { step: "subscriptions", dryRun: false, ...args.args });
const reads = async (args: any = {}) =>
  (sweepPage as any)._handler(args.ctx.ctx, { step: "threadReads", dryRun: false, ...args.args });

describe("creator stamps follow task origin", () => {
  test("agent origin stamps agent; human origin and promotion stamp human", async () => {
    const c = makeCtx({
      entity_subscriptions: [
        sub(ASHOT, "tasks_agent", "creator"),
        sub(ASHOT, "tasks_human", "creator"),
        sub(ASHOT, "tasks_promoted", "creator"),
      ],
    });
    const res = await subs({ ctx: c });
    expect(res.stamped.creator).toEqual({ human: 2, agent: 1 });
    const byTask = Object.fromEntries(c.tables.entity_subscriptions.map((s: any) => [s.entity_id, s.via]));
    expect(byTask).toEqual({ tasks_agent: "agent", tasks_human: "human", tasks_promoted: "human" });
  });
});

describe("assignee stamps: an agent's self-claim for its owner is an agent act", () => {
  test("owner on an agent task is agent; anyone else, or a human task, is human", async () => {
    const c = makeCtx({
      entity_subscriptions: [
        sub(ASHOT, "tasks_agent", "assignee"),
        sub(BOB, "tasks_agent", "assignee"),
        sub(ASHOT, "tasks_human", "assignee"),
      ],
    });
    const res = await subs({ ctx: c });
    expect(res.stamped.assignee).toEqual({ human: 2, agent: 1 });
    const owner = c.tables.entity_subscriptions.find((s: any) => s.user_id === ASHOT && s.entity_id === "tasks_agent");
    expect(owner.via).toBe("agent");
  });
});

describe("commenter stamps from the originating comment", () => {
  test("a terminal comment whose author loosely matches the user is human", async () => {
    const c = makeCtx({
      entity_subscriptions: [sub(ASHOT, "tasks_agent", "commenter")],
      task_comments: [comment("tasks_agent", "ashot")],
    });
    const res = await subs({ ctx: c });
    expect(res.stamped.commenter).toEqual({ human: 1, agent: 0 });
  });

  test("a session comment is agent even under the user's full name", async () => {
    const c = makeCtx({
      entity_subscriptions: [sub(ASHOT, "tasks_agent", "commenter")],
      task_comments: [comment("tasks_agent", "Ashot Petrosian", { conversation_id: "conversations_1" })],
    });
    const res = await subs({ ctx: c });
    expect(res.stamped.commenter).toEqual({ human: 0, agent: 1 });
  });

  test("agent author labels and non-matching names stamp agent", async () => {
    const c = makeCtx({
      entity_subscriptions: [
        sub(ASHOT, "tasks_agent", "commenter"),
        sub(BOB, "tasks_human", "commenter"),
      ],
      task_comments: [
        comment("tasks_agent", "Claude"),
        comment("tasks_human", "Zed Wilson"),
      ],
    });
    const res = await subs({ ctx: c });
    expect(res.stamped.commenter).toEqual({ human: 0, agent: 2 });
  });
});

describe("stored via and via-independent reasons are untouched", () => {
  test("a stored via survives even when the heuristic disagrees", async () => {
    const c = makeCtx({
      // Human task: the creator heuristic would say human, but the row says agent.
      entity_subscriptions: [sub(ASHOT, "tasks_human", "creator", { via: "agent" })],
    });
    const res = await subs({ ctx: c });
    expect(res.keptStored).toBe(1);
    expect(c.db._patched.length).toBe(0);
    expect(c.tables.entity_subscriptions[0].via).toBe("agent");
  });

  test("mentioned rows keep no via — membership never reads it", async () => {
    const c = makeCtx({ entity_subscriptions: [sub(BOB, "tasks_agent", "mentioned")] });
    const res = await subs({ ctx: c });
    expect(res.viaIndependent).toBe(1);
    expect(c.tables.entity_subscriptions[0].via).toBeUndefined();
  });
});

describe("orphans: rows pointing at deleted tasks go away", () => {
  test("subscriptions on a missing task are deleted and counted by reason", async () => {
    const c = makeCtx({
      entity_subscriptions: [
        sub(ASHOT, "tasks_gone", "creator"),
        sub(BOB, "tasks_gone", "commenter"),
        sub(ASHOT, "tasks_agent", "creator"),
      ],
    });
    const res = await subs({ ctx: c });
    expect(res.orphans).toEqual({ creator: 1, commenter: 1 });
    expect(c.tables.entity_subscriptions.map((s: any) => s.entity_id)).toEqual(["tasks_agent"]);
  });

  test("thread_reads on a missing task are deleted", async () => {
    const c = makeCtx({ thread_reads: [read(ASHOT, "tasks_gone")] });
    const res = await reads({ ctx: c });
    expect(res.orphans).toBe(1);
    expect(c.tables.thread_reads.length).toBe(0);
  });
});

describe("thread_reads purge respects taskThreadParticipants", () => {
  const seed = () => makeCtx({
    entity_subscriptions: [
      sub(ASHOT, "tasks_agent", "creator"),          // legacy, stamps agent
      sub(BOB, "tasks_agent", "mentioned"),          // enrolls regardless of via
      sub(CAROL, "tasks_agent", "commenter", { via: "human" }), // own web comment
    ],
    thread_reads: [
      read(ASHOT, "tasks_agent"),
      read(BOB, "tasks_agent"),
      read(CAROL, "tasks_agent"),
    ],
  });

  test("the owner's identity-only row is purged; mentioned and human commenter survive", async () => {
    const c = seed();
    await subs({ ctx: c });
    const res = await reads({ ctx: c });
    expect(res).toMatchObject({ kept: 2, purged: 1, orphans: 0 });
    expect(c.tables.thread_reads.map((r: any) => r.user_id).sort()).toEqual([CAROL, BOB].sort());
    expect(res.perUser["Ashot Petrosian"]).toEqual({ purged: 1 });
    expect(res.perUser["Carol Reed"]).toEqual({ kept: 1 });
  });

  test("dry run answers for the post-stamp world: a heuristic-human commenter row is kept", async () => {
    // Pre-stamp, a legacy commenter row on an agent task grants nothing; the
    // stamp it will earn (matching terminal comment) grants membership. The
    // dry run must count the latter.
    const c = makeCtx({
      entity_subscriptions: [sub(ASHOT, "tasks_agent", "commenter")],
      task_comments: [comment("tasks_agent", "ashot")],
      thread_reads: [read(ASHOT, "tasks_agent")],
    });
    const res = await reads({ ctx: c, args: { dryRun: true } });
    expect(res).toMatchObject({ kept: 1, purged: 0 });
    expect(c.tables.thread_reads.length).toBe(1);
  });
});

describe("dry run mutates nothing", () => {
  test("both steps report counts and leave the tables alone", async () => {
    const c = makeCtx({
      entity_subscriptions: [
        sub(ASHOT, "tasks_agent", "creator"),
        sub(ASHOT, "tasks_gone", "creator"),
      ],
      thread_reads: [read(ASHOT, "tasks_agent"), read(ASHOT, "tasks_gone")],
    });
    const a = await subs({ ctx: c, args: { dryRun: true } });
    const b = await reads({ ctx: c, args: { dryRun: true } });
    expect(a.stamped.creator.agent).toBe(1);
    expect(a.orphans).toEqual({ creator: 1 });
    expect(b).toMatchObject({ purged: 1, orphans: 1 });
    expect(c.db._patched.length).toBe(0);
    expect(c.db._deleted.length).toBe(0);
    expect(c.tables.entity_subscriptions.length).toBe(2);
    expect(c.tables.thread_reads.length).toBe(2);
  });

  test("omitting dryRun defaults to dry", async () => {
    const c = makeCtx({ entity_subscriptions: [sub(ASHOT, "tasks_agent", "creator")] });
    await (sweepPage as any)._handler(c.ctx, { step: "subscriptions" });
    expect(c.db._patched.length).toBe(0);
  });
});

describe("the driver action pages through everything and is idempotent", () => {
  test("totals merge across pages; a second live run finds nothing to do", async () => {
    const many = Array.from({ length: 450 }, (_, i) =>
      sub(i % 2 ? ASHOT : BOB, "tasks_agent", "creator"));
    const c = makeCtx({
      entity_subscriptions: [...many, sub(ASHOT, "tasks_gone", "commenter")],
      thread_reads: [read(ASHOT, "tasks_agent"), read(BOB, "tasks_agent")],
    });
    const actionCtx = {
      runMutation: (_ref: unknown, args: any) => (sweepPage as any)._handler(c.ctx, args),
    } as any;
    const first = await (sweep as any)._handler(actionCtx, { dryRun: false });
    expect(first.subscriptions.scanned).toBe(451);
    expect(first.subscriptions.stamped.creator.agent).toBe(450);
    expect(first.subscriptions.orphans).toEqual({ commenter: 1 });
    // Neither the owner (identity-only creator) nor Bob (agent-stamped creator)
    // is a participant, so both rows go.
    expect(first.threadReads).toMatchObject({ kept: 0, purged: 2 });

    const again = await (sweep as any)._handler(actionCtx, { dryRun: false });
    expect(again.subscriptions.keptStored).toBe(450);
    expect(again.subscriptions.stamped).toEqual({});
    expect(again.threadReads.scanned).toBe(0);
  });
});
