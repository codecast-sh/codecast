// Removing a task's last open blocker unblocks it the way a closing blocker
// does (docs/architecture/task-graph.md TG2): the task says so, once, and a
// removal that leaves another blocker open says nothing. The web's Blocked by
// row and `cast task dep --remove` share removeDepCore.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDepCore, removeDep, removeDepCore } from "./tasks";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "dep-removal-test-token";

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
    task_comments: [],
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
      db: makeFakeDb(tables),
      scheduler: { runAfter: async () => null, runAt: async () => null },
      runMutation: async () => null,
    } as any,
    tables,
  };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  title: shortId,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const row = (tables: Record<string, any[]>, shortId: string) => tables.tasks.find((t) => t.short_id === shortId);
const unblockedNotes = (tables: Record<string, any[]>) => tables.task_comments.filter((c) => String(c.text).startsWith("Unblocked:"));

describe("removing a blocker (TG2, TG12)", () => {
  test("the last open blocker removed unblocks the task, with both mirrors gone", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await removeDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(unblockedNotes(tables).map((c) => c.text)).toEqual(["Unblocked: the blocker ct-1 was removed"]);
  });

  test("named from the blocker's side, the dependent is the one unblocked", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await removeDep._handler(ctx, { api_token: TOKEN, short_id: "ct-1", blocks: "ct-2" });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(unblockedNotes(tables).map((c) => String(c.task_id))).toEqual(["task_ct-2"]);
  });

  test("another open blocker keeps it blocked, and a done blocker's removal releases nothing", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1"),
      task("ct-3"),
      task("ct-2", { blocked_by: ["ct-1", "ct-3"] }),
      task("ct-4", { status: "done" }),
      task("ct-5", { blocked_by: ["ct-4"] }),
    ]);
    await removeDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" });
    await removeDepCore(ctx, USER as any, { short_id: "ct-5", blocked_by: "ct-4" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-3"]);
    expect(unblockedNotes(tables)).toEqual([]);
  });

  test("a blocker that no longer exists is removable", async () => {
    const { ctx, tables } = await makeCtx([task("ct-2", { blocked_by: ["ct-404"] })]);
    await removeDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-404" });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
  });

  test("the web's add goes through the same loop check as the CLI", async () => {
    const { ctx } = await makeCtx([task("ct-1", { blocked_by: ["ct-2"] }), task("ct-2", { blocks: ["ct-1"] })]);
    await expect(addDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" })).rejects.toThrow(/loop/);
  });
});
