// Claiming the frontier, execution hints and ephemeral tasks
// (docs/architecture/task-graph.md TG7-TG9): the ready list reads in the order
// work should be taken and flags what has gone stale, a claim starts the first
// row it may start, model/effort/ephemeral write through update, and an
// ephemeral task stays off the default list and out of the bell.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { create, list, update } from "./tasks";
import { claimCandidates, claimFrontier, claimNextReady } from "./taskFrontier";
import { emitNotification } from "./notificationRouter";
import { hashToken } from "./apiTokens";
import { STALE_TASK_MS } from "@codecast/shared/tasks";

const USER = "u_user";
const TOKEN = "task-frontier-test-token";
// A real-shaped user id, which is what the assignee name lookup resolves.
const TEAMMATE = "t".repeat(32);
const NOW = Date.now();

async function makeCtx(tasks: any[], extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: "u_other", name: "Other" }, { _id: TEAMMATE, name: "Teammate" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
    notifications: [],
    entity_subscriptions: [],
    ...extra,
  };
  // Nested calls run the real handlers against the same db, the way Convex
  // runs them inside the caller's transaction. A nested start is a
  // sub-transaction: when it throws, every write it made is undone.
  const handlers: Record<string, any> = {
    "tasks:list": list,
    "tasks:update": update,
    "taskFrontier:claimCandidates": claimCandidates,
    "taskFrontier:claimNextReady": claimNextReady,
  };
  const db: any = makeFakeDb(tables);
  const ctx: any = {
    auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
    db,
    scheduler: { runAfter: async () => null, runAt: async () => null },
    runQuery: (ref: any, args: any) => handlers[getFunctionName(ref)]._handler(ctx, args),
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      const h = handlers[name];
      if (!h) return null;
      if (name !== "tasks:update") return h._handler(ctx, args);
      db.__beginJournal();
      try {
        const out = await h._handler(ctx, args);
        db.__commit();
        return out;
      } catch (err) {
        db.__rollback();
        throw err;
      }
    },
  };
  return { ctx, tables };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  title: shortId,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: NOW - 1000,
  updated_at: NOW - 1000,
  ...over,
});

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, { api_token: TOKEN, ...args });
const order = (rows: any[]) => rows.map((t) => t.short_id);

describe("the ready frontier's order (TG7)", () => {
  test("priority, then plan order, then oldest; stale rows last and flagged", async () => {
    const stale = NOW - STALE_TASK_MS - 1;
    const { ctx } = await makeCtx([
      task("ct-1", { priority: "low" }),
      task("ct-2", { priority: "urgent", updated_at: stale, created_at: stale }),
      task("ct-3", { priority: "high", plan_id: "plan_1" }),
      task("ct-4", { priority: "high", plan_id: "plan_1" }),
      task("ct-5", { priority: "high", created_at: NOW - 5000 }),
      task("ct-6", { priority: "high", created_at: NOW - 9000 }),
    ], { plans: [{ _id: "plan_1", short_id: "pl-1", task_ids: ["task_ct-4", "task_ct-3"] }] });
    const rows = await call(list, ctx, { ready: true });
    expect(order(rows)).toEqual(["ct-4", "ct-3", "ct-6", "ct-5", "ct-1", "ct-2"]);
    expect(rows.filter((r: any) => r.stale).map((r: any) => r.short_id)).toEqual(["ct-2"]);
  });

  test("a list that is not the frontier stays newest first and carries no stale flag", async () => {
    const { ctx } = await makeCtx([task("ct-1", { updated_at: NOW - 10 }), task("ct-2", { priority: "urgent", updated_at: NOW - 20 })]);
    const rows = await call(list, ctx, {});
    expect(order(rows)).toEqual(["ct-1", "ct-2"]);
    expect(rows[0].stale).toBeUndefined();
  });
});

describe("ephemeral tasks (TG9)", () => {
  test("left off the default list, listed on request and in the owner's frontier", async () => {
    const { ctx } = await makeCtx([task("ct-1"), task("ct-2", { ephemeral: true })]);
    expect(order(await call(list, ctx, {}))).toEqual(["ct-1"]);
    expect(order(await call(list, ctx, { include_ephemeral: true })).sort()).toEqual(["ct-1", "ct-2"]);
    expect(order(await call(list, ctx, { ready: true })).sort()).toEqual(["ct-1", "ct-2"]);
  });

  test("a session's ephemeral task is on its own frontier only, not its person's other sessions'", async () => {
    const { ctx } = await makeCtx([task("ct-1"), task("ct-2", { ephemeral: true, created_from_conversation: "c_other" })], {
      conversations: [
        { _id: "c_me", user_id: USER, session_id: "sess-me", is_private: true },
        { _id: "c_other", user_id: USER, session_id: "sess-other", is_private: true },
      ],
      managed_sessions: [],
    });
    expect(order(await call(list, ctx, { ready: true, conversation_id: "sess-me" }))).toEqual(["ct-1"]);
    expect(order(await call(list, ctx, { ready: true }))).toEqual(["ct-1"]);
    expect(order(await call(list, ctx, { ready: true, conversation_id: "sess-other" })).sort()).toEqual(["ct-1", "ct-2"]);
  });

  test("a notification about an ephemeral task rings nobody", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { ephemeral: true }), task("ct-2")]);
    const emit = (taskId: string) => emitNotification(ctx, {
      event_type: "task_assigned",
      actor_user_id: "u_other" as any,
      entity_type: "task",
      entity_id: taskId,
      message: "assigned you",
      direct_recipient_id: USER as any,
    });
    expect(await emit("task_ct-1")).toEqual({ notified: 0 });
    expect(tables.notifications).toHaveLength(0);
    await emit("task_ct-2");
    expect(tables.notifications).toHaveLength(1);
  });

  test("a machine assignment of an ephemeral task leaves the open fold row alone", async () => {
    const { ctx, tables } = await makeCtx([]);
    tables.users[0].is_bot = true;
    const open = { _id: "n_1", recipient_user_id: TEAMMATE, actor_user_id: USER, type: "task_assigned", read: false, entity_id: "task_x", message: "assigned you to ct-9: x", created_at: NOW - 1000 };
    tables.notifications.push({ ...open });
    await call(create, ctx, { title: "probe", ephemeral: true, assignee: TEAMMATE });
    expect(tables.notifications).toEqual([open]);
    // The same assignment of real work folds in.
    await call(create, ctx, { title: "real", assignee: TEAMMATE });
    expect(tables.notifications).toMatchObject([{ _id: "n_1", fold_count: 2 }]);
  });

  test("keep clears it; create and update write model and effort, and '' clears", async () => {
    const { ctx, tables } = await makeCtx([]);
    const { short_id } = await call(create, ctx, { title: "probe", ephemeral: true, effort: "high", model: "sonnet" });
    const row = () => tables.tasks.find((t) => t.short_id === short_id);
    expect(row()).toMatchObject({ ephemeral: true, effort: "high", model: "sonnet" });
    await call(update, ctx, { short_id, ephemeral: false, effort: "max" });
    expect(row().ephemeral).toBeUndefined();
    expect(row().effort).toBe("max");
    await call(update, ctx, { short_id, effort: "", model: "" });
    expect(row().effort).toBeUndefined();
    expect(row().model).toBeUndefined();
  });
});

describe("claiming the frontier (TG7)", () => {
  const claim = (ctx: any, args: any = {}) => claimFrontier(ctx, { api_token: TOKEN, ...args });
  const status = (tables: any, shortId: string) => tables.tasks.find((t: any) => t.short_id === shortId).status;

  // The caller's own session, and a teammate session that owns ct-1 and is
  // still working (touched just now).
  const sessions = () => ({
    conversations: [
      { _id: "c_me", user_id: USER, session_id: "sess-me", short_id: "jme0001", is_private: true, status: "active", updated_at: NOW },
      { _id: "c_other", user_id: USER, session_id: "sess-other", short_id: "jot0001", is_private: true, status: "active", updated_at: NOW, active_task_id: "task_ct-1" },
    ],
    managed_sessions: [],
    entity_conversations: [],
  });

  test("starts the first frontier task, and the next claim takes the one after", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { priority: "low" }),
      task("ct-2", { priority: "high" }),
      task("ct-3", { blocked_by: ["ct-2"], priority: "urgent" }),
    ]);
    expect((await claim(ctx)).task?.short_id).toBe("ct-2");
    expect(status(tables, "ct-2")).toBe("in_progress");
    expect((await claim(ctx)).task?.short_id).toBe("ct-1");
    expect(await claim(ctx)).toMatchObject({ task: null, skipped: [] });
  });

  test("a candidate another claim started after the frontier was read is passed over", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { priority: "high" }), task("ct-2")]);
    const { candidates } = await claimCandidates._handler(ctx, { api_token: TOKEN });
    expect(candidates).toEqual(["ct-1", "ct-2"]);
    // The racing claim wins ct-1 between this claim's two steps.
    await call(update, ctx, { short_id: "ct-1", status: "in_progress" });
    const res = await claimNextReady._handler(ctx, { api_token: TOKEN, candidates });
    expect(res).toMatchObject({ task: { short_id: "ct-2" }, skipped: [{ short_id: "ct-1", reason: "already in_progress" }] });
    expect(status(tables, "ct-2")).toBe("in_progress");
  });

  test("claimable work far down a frontier of other people's tasks is still found", async () => {
    const theirs = Array.from({ length: 60 }, (_, i) => task(`ct-${i + 10}`, { priority: "urgent", assignee: TEAMMATE }));
    const { ctx } = await makeCtx([...theirs, task("ct-1", { priority: "low" })]);
    expect(await claim(ctx)).toMatchObject({ task: { short_id: "ct-1" } });
  });

  test("an agent's task is a session's to claim, never a person's", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { assignee: "agent:claude" })], sessions());
    expect(await claim(ctx)).toMatchObject({ task: null });
    const direct = await claimNextReady._handler(ctx, { api_token: TOKEN, candidates: ["ct-1"] });
    expect(direct.skipped).toEqual([{ short_id: "ct-1", reason: "assigned to an agent" }]);
    expect((await claim(ctx, { conversation_id: "sess-me" })).task?.short_id).toBe("ct-1");
    expect(status(tables, "ct-1")).toBe("in_progress");
  });

  test("a start refused partway leaves nothing behind and the claim takes the next row", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { priority: "urgent", conversation_ids: ["c_other"] }),
      task("ct-2"),
    ], sessions());
    const res = await claim(ctx, { conversation_id: "sess-me" });
    expect(res.task?.short_id).toBe("ct-2");
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ short_id: "ct-1" });
    expect(res.skipped[0].reason).toMatch(/owned by session jot0001/);
    // The refused start had linked this session to ct-1 before ownership
    // refused it; the rollback undid that.
    const ct1 = tables.tasks.find((t: any) => t.short_id === "ct-1");
    expect(ct1).toMatchObject({ status: "open", conversation_ids: ["c_other"] });
    expect(tables.entity_conversations.map((l: any) => l.entity_id)).toEqual(["task_ct-2"]);
    expect(tables.task_history.filter((h: any) => h.task_id === "task_ct-1")).toHaveLength(0);
    expect(tables.conversations.find((c: any) => c._id === "c_me").active_task_id).toBe("task_ct-2");
  });

  test("a teammate's task is never claimed; the caller's own and its role's are", async () => {
    const extra = sessions();
    (extra.conversations[0] as any).org_role_id = "role_1";
    const { ctx, tables } = await makeCtx([
      task("ct-1", { priority: "urgent", assignee: TEAMMATE }),
      task("ct-2", { priority: "high", assignee: USER }),
      task("ct-3", { assignee: "role_1" }),
    ], extra);
    expect((await claim(ctx)).task?.short_id).toBe("ct-2");
    expect(await claim(ctx)).toMatchObject({ task: null });
    expect((await claim(ctx, { conversation_id: "sess-me" })).task?.short_id).toBe("ct-3");
    expect(tables.tasks.find((t: any) => t.short_id === "ct-1")).toMatchObject({ status: "open", assignee: TEAMMATE });
    // A candidate assigned away after the frontier was read is passed over by name.
    const direct = await claimNextReady._handler(ctx, { api_token: TOKEN, candidates: ["ct-1"] });
    expect(direct).toEqual({ task: null, skipped: [{ short_id: "ct-1", reason: "assigned to Teammate" }] });
  });

  test("a blocking decision holds a task against a person's claim too", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { priority: "urgent" }), task("ct-2")], {
      session_decisions: [{ _id: "d_1", short_id: "sd-3", task_id: "task_ct-1", status: "pending", blocking: true, station: "open" }],
    });
    expect((await claim(ctx)).task?.short_id).toBe("ct-2");
    expect(status(tables, "ct-1")).toBe("open");
    const direct = await claimNextReady._handler(ctx, { api_token: TOKEN, candidates: ["ct-1"] });
    expect(direct.skipped[0].reason).toMatch(/^Held at open by sd-3/);
  });

  test("a stale task is claimed only with stale; an ephemeral one only by the session that filed it", async () => {
    const stale = NOW - STALE_TASK_MS - 1;
    const { ctx } = await makeCtx([
      task("ct-1", { updated_at: stale, created_at: stale }),
      task("ct-2", { ephemeral: true, created_from_conversation: "c_other" }),
    ], sessions());
    expect(await claim(ctx, { conversation_id: "sess-me" })).toMatchObject({ task: null });
    expect((await claim(ctx, { conversation_id: "sess-me", stale: true })).task?.short_id).toBe("ct-1");
    expect((await claim(ctx, { conversation_id: "sess-other" })).task?.short_id).toBe("ct-2");
  });

  test("the list's filters narrow what a claim may take", async () => {
    const { ctx } = await makeCtx([task("ct-1", { priority: "urgent" }), task("ct-2", { labels: ["queue"] })]);
    expect((await claim(ctx, { label: "queue" })).task?.short_id).toBe("ct-2");
  });
});
