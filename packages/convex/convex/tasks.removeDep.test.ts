// Removing a dependency edge (`cast task dep --remove`, the web's Blocked by
// row; both reach removeDepCore) clears both sides of the mirror, and removing
// a task's last open blocker unblocks it the way a closing blocker does
// (docs/architecture/task-graph.md TG2): the task says so, once.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDep, addDepCore, removeDep, removeDepCore } from "./tasks";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "dep-test-token";

/** A session bound to ct-2: it owns it (lib/taskOwner). */
const owner = { _id: "conv_owner", short_id: "jx7own", session_id: "sess_owner", user_id: USER, status: "active", active_task_id: "task_ct-2", updated_at: 1 };

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
    task_comments: [],
    conversations: [owner],
    pending_messages: [],
    notifications: [],
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
const remove = (ctx: any, args: Record<string, string>) => (removeDep as any)._handler(ctx, { api_token: TOKEN, ...args });

describe("removeDep", () => {
  test("--remove-blocked-by clears the edge on both sides and unblocks the task", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await remove(ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(unblockedNotes(tables).map((c) => c.text)).toEqual(["Unblocked: the blocker ct-1 was removed"]);
  });

  test("--remove-blocks clears the edge on both sides, and the dependent is the one unblocked", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await remove(ctx, { short_id: "ct-1", blocks: "ct-2" });
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(unblockedNotes(tables).map((c) => String(c.task_id))).toEqual(["task_ct-2"]);
  });

  test("errors clearly when the edge does not exist", async () => {
    const { ctx } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await expect(remove(ctx, { short_id: "ct-2", blocked_by: "ct-nope" })).rejects.toThrow("ct-2 has no blocked-by dependency on ct-nope");
    await expect(remove(ctx, { short_id: "ct-2", blocks: "ct-1" })).rejects.toThrow("ct-2 has no blocks dependency on ct-1");
  });

  // The usual cause is the edge named the other way round.
  test("a remove naming the edge backwards says which way it points", async () => {
    const { ctx } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await expect(remove(ctx, { short_id: "ct-1", blocked_by: "ct-2" })).rejects.toThrow(
      "ct-1 has no blocked-by dependency on ct-2; ct-2 waits on ct-1 instead (cast task dep ct-2 --remove-blocked-by ct-1)");
    await expect(remove(ctx, { short_id: "ct-2", blocks: "ct-1" })).rejects.toThrow(
      "ct-2 has no blocks dependency on ct-1; ct-2 waits on ct-1 instead (cast task dep ct-2 --remove-blocked-by ct-1)");
  });

  test("removes a dangling edge whose other task no longer exists", async () => {
    const { ctx, tables } = await makeCtx([task("ct-2", { blocked_by: ["ct-404"] })]);
    await remove(ctx, { short_id: "ct-2", blocked_by: "ct-404" });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
  });

  test("an older plan row's blocker, stored by _id, is removed by either name", async () => {
    for (const ref of ["ct-1", "task_ct-1"]) {
      const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["task_ct-1"] })]);
      await remove(ctx, { short_id: "ct-2", blocked_by: ref });
      expect(row(tables, "ct-2").blocked_by).toEqual([]);
      expect(row(tables, "ct-1").blocks).toEqual([]);
      expect(unblockedNotes(tables).map((c) => c.text)).toEqual(["Unblocked: the blocker ct-1 was removed"]);
    }
  });

  test("removed from the blocker's side, a dependent naming it by its _id is unblocked", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["task_ct-1"] })]);
    await removeDepCore(ctx, USER as any, { short_id: "ct-1", blocks: "ct-2" });
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(unblockedNotes(tables).map((c) => String(c.task_id))).toEqual(["task_ct-2"]);
  });

  test("a short id and its _id are one edge: adding never doubles it, and removing takes every form", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["task_ct-1"] })]);
    await addDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" });
    await addDepCore(ctx, USER as any, { short_id: "ct-1", blocks: "ct-2" });
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-1").blocks]).toEqual([["task_ct-1"], ["ct-2"]]);

    // A row that already holds both forms loses both.
    row(tables, "ct-2").blocked_by = ["task_ct-1", "ct-1"];
    await remove(ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-1").blocks]).toEqual([[], []]);
    expect(unblockedNotes(tables).map((c) => c.text)).toEqual(["Unblocked: the blocker ct-1 was removed"]);
  });

  test("only touches the named edge; another open blocker keeps it blocked", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-3", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "ct-3"] }),
    ]);
    await remove(ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-3"]);
    expect(row(tables, "ct-3").blocks).toEqual(["ct-2"]);
    expect(unblockedNotes(tables)).toEqual([]);
  });

  test("a done blocker's removal releases nothing", async () => {
    const { ctx, tables } = await makeCtx([task("ct-4", { status: "done" }), task("ct-5", { blocked_by: ["ct-4"] })]);
    await removeDepCore(ctx, USER as any, { short_id: "ct-5", blocked_by: "ct-4" });
    expect(unblockedNotes(tables)).toEqual([]);
  });

  test("the owning session removing its own blocker is not woken, and the history names it", async () => {
    const graph = () => [task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"], conversation_ids: ["conv_owner"] })];
    const own = await makeCtx(graph());
    await remove(own.ctx, { short_id: "ct-2", blocked_by: "ct-1", conversation_id: "sess_owner" });
    expect(unblockedNotes(own.tables)).toHaveLength(1);
    expect(own.tables.pending_messages).toEqual([]);
    expect(own.tables.task_history.map((h) => h.actor_type)).toEqual(["agent"]);

    const person = await makeCtx(graph());
    await remove(person.ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    expect(person.tables.pending_messages.map((m) => m.conversation_id)).toEqual(["conv_owner"]);
  });

  test("round-trips with addDep", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    await (addDep as any)._handler(ctx, { api_token: TOKEN, short_id: "ct-2", blocked_by: "ct-1" });
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-1").blocks]).toEqual([["ct-1"], ["ct-2"]]);
    await remove(ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-1").blocks]).toEqual([[], []]);
  });

  test("the web's add goes through the same loop check as the CLI", async () => {
    const { ctx } = await makeCtx([task("ct-1", { blocked_by: ["ct-2"] }), task("ct-2", { blocks: ["ct-1"] })]);
    await expect(addDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" })).rejects.toThrow(/loop/);
  });

  test("a ref that names no task is named in the error", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    await expect(addDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-999" })).rejects.toThrow("Task ct-999 not found");
    await expect(removeDepCore(ctx, USER as any, { short_id: "ct-404", blocked_by: "ct-1" })).rejects.toThrow("Task ct-404 not found");
    await addDepCore(ctx, USER as any, { short_id: "ct-2", blocks: "ct-1" });
    expect([row(tables, "ct-2").blocks, row(tables, "ct-1").blocked_by]).toEqual([["ct-1"], ["ct-2"]]);
    expect(tables.task_history.map((h) => [String(h.task_id), h.field, h.new_value])).toEqual([["task_ct-1", "blocked_by", "ct-2"]]);
  });

  test("rejects a task the caller cannot access", async () => {
    const { ctx } = await makeCtx([task("ct-x", { user_id: "u_other", blocked_by: ["ct-1"] })]);
    await expect(remove(ctx, { short_id: "ct-x", blocked_by: "ct-1" })).rejects.toThrow("Task ct-x not found");
  });

  // The web's removal rides the durable outbox, which replays an entry whose
  // ack never arrived: a removal that committed must not fail on every boot.
  // The CLI keeps the loud error, since applyBlockers reads its exit code.
  describe("an edge already gone", () => {
    const gone = () => [task("ct-1"), task("ct-2")];

    test("is a no-op for a caller that asked to tolerate it", async () => {
      const { ctx, tables } = await makeCtx(gone());
      for (const args of [{ blocked_by: "ct-1" }, { blocks: "ct-1" }] as const) {
        expect(await removeDepCore(ctx, USER as any, { short_id: "ct-2", ...args }, undefined, { missing: "ignore" })).toEqual({ success: true });
      }
      expect([row(tables, "ct-2").blocked_by, row(tables, "ct-2").blocks]).toEqual([undefined, undefined]);
      expect(tables.task_history).toEqual([]);
      expect(unblockedNotes(tables)).toEqual([]);
    });

    test("still fails by default, so an agent never reads it as unblocked", async () => {
      const { ctx } = await makeCtx(gone());
      await expect(remove(ctx, { short_id: "ct-2", blocked_by: "ct-1" }))
        .rejects.toThrow("ct-2 has no blocked-by dependency on ct-1");
    });

    test("replaying the real removal twice leaves one history row and one unblock", async () => {
      const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
      const replay = () => removeDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" }, undefined, { missing: "ignore" });
      await replay();
      await replay();
      expect([row(tables, "ct-2").blocked_by, row(tables, "ct-1").blocks]).toEqual([[], []]);
      expect(tables.task_history.filter((h) => h.field === "blocked_by")).toHaveLength(1);
      expect(unblockedNotes(tables)).toHaveLength(1);
    });
  });
});
