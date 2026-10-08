// Claiming the frontier, execution hints and ephemeral tasks
// (docs/architecture/task-graph.md TG7-TG9): the ready list reads in the order
// work should be taken and flags what has gone stale, a claim starts the first
// row it may start, model/effort/ephemeral write through update, and an
// ephemeral task stays off the default list and out of the bell.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { create, list, update } from "./tasks";
import { claimNextReady } from "./taskFrontier";
import { emitNotification } from "./notificationRouter";
import { hashToken } from "./apiTokens";
import { STALE_TASK_MS } from "@codecast/shared/tasks";

const USER = "u_user";
const TOKEN = "task-frontier-test-token";
const NOW = Date.now();

async function makeCtx(tasks: any[], extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: "u_other", name: "Other" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
    notifications: [],
    entity_subscriptions: [],
    ...extra,
  };
  // Nested calls run the real handlers against the same db, the way Convex
  // runs them inside the caller's transaction.
  const handlers: Record<string, any> = { "tasks:list": list, "tasks:update": update };
  const ctx: any = {
    auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
    db: makeFakeDb(tables),
    scheduler: { runAfter: async () => null, runAt: async () => null },
    runQuery: (ref: any, args: any) => handlers[getFunctionName(ref)]._handler(ctx, args),
    runMutation: (ref: any, args: any) => {
      const h = handlers[getFunctionName(ref)];
      return h ? h._handler(ctx, args) : null;
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

describe("claimNextReady (TG7)", () => {
  test("starts the first frontier task, and the next claim takes the one after", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { priority: "low" }),
      task("ct-2", { priority: "high" }),
      task("ct-3", { blocked_by: ["ct-2"], priority: "urgent" }),
    ]);
    const first = await call(claimNextReady, ctx, { assignee: "me" });
    expect(first.task?.short_id).toBe("ct-2");
    expect(tables.tasks.find((t) => t.short_id === "ct-2").status).toBe("in_progress");
    const second = await call(claimNextReady, ctx, { assignee: "me" });
    expect(second.task?.short_id).toBe("ct-1");
    expect(await call(claimNextReady, ctx, { assignee: "me" })).toEqual({ task: null, skipped: [] });
  });

  test("a refused start passes to the next row and says why", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { priority: "urgent" }), task("ct-2")]);
    const real = ctx.runMutation;
    ctx.runMutation = (ref: any, args: any) => {
      if (args.short_id === "ct-1") throw new Error("ct-1 is owned by a working session");
      return real(ref, args);
    };
    const res = await call(claimNextReady, ctx, { assignee: "me" });
    expect(res.task?.short_id).toBe("ct-2");
    expect(res.skipped).toEqual([{ short_id: "ct-1", reason: "ct-1 is owned by a working session" }]);
    expect(tables.tasks.find((t) => t.short_id === "ct-1").status).toBe("open");
  });

  test("the list's filters narrow what a claim may take", async () => {
    const { ctx } = await makeCtx([task("ct-1", { priority: "urgent" }), task("ct-2", { labels: ["queue"] })]);
    expect((await call(claimNextReady, ctx, { assignee: "me", label: "queue" })).task?.short_id).toBe("ct-2");
  });
});
