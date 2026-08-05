import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDep, removeDep } from "./tasks";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "dep-test-token";

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return null; } },
      db: makeFakeDb(tables),
      scheduler: { runAfter: async () => null },
      runMutation: async () => null,
    } as any,
    tables,
  };
}

const taskA = () => ({ _id: "task_a", short_id: "ct-a", user_id: USER, status: "open", blocked_by: ["ct-b"] });
const taskB = () => ({ _id: "task_b", short_id: "ct-b", user_id: USER, status: "dropped", blocks: ["ct-a"] });

describe("removeDep", () => {
  test("--remove-blocked-by clears the edge on both sides", async () => {
    const { ctx, tables } = await makeCtx([taskA(), taskB()]);
    await (removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-b" });
    expect(tables.tasks[0].blocked_by).toEqual([]);
    expect(tables.tasks[1].blocks).toEqual([]);
  });

  test("--remove-blocks clears the edge on both sides", async () => {
    const { ctx, tables } = await makeCtx([taskA(), taskB()]);
    await (removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-b", blocks: "ct-a" });
    expect(tables.tasks[1].blocks).toEqual([]);
    expect(tables.tasks[0].blocked_by).toEqual([]);
  });

  test("errors clearly when the edge does not exist", async () => {
    const { ctx } = await makeCtx([taskA(), taskB()]);
    await expect((removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-nope" }))
      .rejects.toThrow("ct-a has no blocked-by dependency on ct-nope");
    await expect((removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocks: "ct-b" }))
      .rejects.toThrow("ct-a has no blocks dependency on ct-b");
  });

  test("removes a dangling edge whose other task no longer exists", async () => {
    const { ctx, tables } = await makeCtx([taskA()]);
    await (removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-b" });
    expect(tables.tasks[0].blocked_by).toEqual([]);
  });

  test("only touches the named edge", async () => {
    const a = { ...taskA(), blocked_by: ["ct-b", "ct-c"] };
    const c = { _id: "task_c", short_id: "ct-c", user_id: USER, status: "open", blocks: ["ct-a"] };
    const { ctx, tables } = await makeCtx([a, taskB(), c]);
    await (removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-b" });
    expect(tables.tasks[0].blocked_by).toEqual(["ct-c"]);
    expect(tables.tasks[2].blocks).toEqual(["ct-a"]);
  });

  test("round-trips with addDep", async () => {
    const { ctx, tables } = await makeCtx([
      { _id: "task_a", short_id: "ct-a", user_id: USER, status: "open" },
      { _id: "task_b", short_id: "ct-b", user_id: USER, status: "open" },
    ]);
    await (addDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-b" });
    expect(tables.tasks[0].blocked_by).toEqual(["ct-b"]);
    expect(tables.tasks[1].blocks).toEqual(["ct-a"]);
    await (removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-a", blocked_by: "ct-b" });
    expect(tables.tasks[0].blocked_by).toEqual([]);
    expect(tables.tasks[1].blocks).toEqual([]);
  });

  test("rejects a task the caller cannot access", async () => {
    const { ctx } = await makeCtx([{ _id: "task_x", short_id: "ct-x", user_id: "u_other", status: "open", blocked_by: ["ct-a"] }]);
    await expect((removeDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-x", blocked_by: "ct-a" }))
      .rejects.toThrow("Task not found");
  });
});
