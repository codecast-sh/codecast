// Links that do not block (docs/architecture/task-graph.md TG5): found_during
// fills itself from the creating session's bound task, superseding and
// marking a duplicate move the old task's dependents to the replacement (and
// refuse a loop), related is mirrored on both rows, and every link reaches
// `cast task show`/`context` resolved.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { context, create, get, updateTaskAs } from "./tasks";
import { relate, supersede, unrelate, webFoundHere } from "./taskLinks";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const OTHER = "u_other";
const TOKEN = "task-links-test-token";
const SESSION = "sess-bound";

async function makeCtx(tasks: any[], conv: any = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: OTHER, name: "Other" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    conversations: [{ _id: "conv_1", user_id: USER, session_id: SESSION, is_private: true, ...conv }],
    counters: [{ _id: "counter_ct", name: "ct", value: 100 }],
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
  title: `Title ${shortId}`,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, { api_token: TOKEN, ...args });
const row = (tables: any, id: string) => tables.tasks.find((t: any) => t.short_id === id);
const historyOf = (tables: any, id: string, field: string) =>
  tables.task_history.filter((h: any) => h.task_id === `task_${id}` && h.field === field).map((h: any) => [h.old_value, h.new_value]);

describe("found_during (TG5)", () => {
  test("fills from the creating session's bound task and records it", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")], { active_task_id: "task_ct-1" });
    const { short_id } = await call(create, ctx, { title: "Found bug", conversation_id: SESSION });
    expect(row(tables, short_id).found_during).toBe("ct-1");
    expect(tables.task_history.filter((h: any) => h.field === "found_during").map((h: any) => h.new_value)).toEqual(["ct-1"]);
  });

  test("skips the bound task's own subtasks, deep ones included, and its plan's steps", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { plan_id: "plan_1" }),
      task("ct-2", { parent_id: "task_ct-1" }),
    ], { active_task_id: "task_ct-1" });
    tables.plans = [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "P", status: "active", task_ids: ["task_ct-1"], created_at: 1, updated_at: 1 }];
    const sub = await call(create, ctx, { title: "Sub", conversation_id: SESSION, parent_id: "ct-1" });
    const deep = await call(create, ctx, { title: "Deeper", conversation_id: SESSION, parent_id: "ct-2" });
    const step = await call(create, ctx, { title: "Step", conversation_id: SESSION, plan_id: "pl-1" });
    for (const r of [sub, deep, step]) expect(row(tables, r.short_id).found_during).toBeUndefined();
  });

  test("an explicit value wins, and none skips the default", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")], { active_task_id: "task_ct-1" });
    const explicit = await call(create, ctx, { title: "A", conversation_id: SESSION, found_during: "ct-5" });
    const none = await call(create, ctx, { title: "B", conversation_id: SESSION, found_during: "none" });
    expect(row(tables, explicit.short_id).found_during).toBe("ct-5");
    expect(row(tables, none.short_id).found_during).toBeUndefined();
  });

  test("an explicit task in another workspace is refused; a bound one there is skipped", async () => {
    const foreign = task("ct-9", { user_id: OTHER, team_id: "team_x", workspace: "team:team_x" });
    const { ctx, tables } = await makeCtx([foreign], { active_task_id: "task_ct-9" });
    tables.team_memberships = [{ _id: "m1", user_id: USER, team_id: "team_x", role: "member" }];
    await expect(call(create, ctx, { title: "A", found_during: "ct-9" })).rejects.toThrow(/another workspace|not found/i);
    const auto = await call(create, ctx, { title: "B", conversation_id: SESSION });
    expect(row(tables, auto.short_id).found_during).toBeUndefined();
  });

  test("the source lists what was found there; show and context resolve every link", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { related: ["ct-3"] }),
      task("ct-2", { found_during: "ct-1", superseded_by: "ct-3", status: "dropped" }),
      task("ct-3", { related: ["ct-1"] }),
    ]);
    const found = await webFoundHere._handler(ctx, { short_id: "ct-1" });
    expect(found).toEqual([{ short_id: "ct-2", title: "Title ct-2", status: "dropped" }]);
    const shown = await call(get, ctx, { short_id: "ct-2" });
    expect(shown.links.found_during.short_id).toBe("ct-1");
    expect(shown.links.superseded_by.short_id).toBe("ct-3");
    const ctx1 = await call(context, ctx, { short_id: "ct-1" });
    expect(ctx1.links.found_here.map((r: any) => r.short_id)).toEqual(["ct-2"]);
    expect(ctx1.links.related.map((r: any) => r.short_id)).toEqual(["ct-3"]);
  });
});

describe("supersede (TG5)", () => {
  test("drops the old task with a note, sets superseded_by, and moves its dependents", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3", "ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["task_ct-1", "ct-9"] }),
      task("ct-4", { blocked_by: ["ct-1"], status: "done" }),
      task("ct-5"),
      task("ct-9"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5", note: "Rewritten scope." });
    expect(res.moved).toEqual(["ct-2", "ct-3"]);
    const old = row(tables, "ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual(["dropped", "ct-5", ["ct-4"]]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-9", "ct-5"]);
    // A finished dependent keeps its history.
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-2", "ct-3"]);
    expect(tables.task_comments.map((c: any) => c.text)).toEqual(["Superseded by ct-5. Rewritten scope. Its dependents now wait on it: ct-2, ct-3."]);
    expect(historyOf(tables, "ct-1", "superseded_by")).toEqual([["", "ct-5"]]);
    expect(historyOf(tables, "ct-2", "blocked_by")).toEqual([["ct-1", "ct-5"]]);
  });

  test("a move that would close a loop is refused and nothing is written", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-2"] }),
    ]);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-5" })).rejects.toThrow(/loop/);
    expect([row(tables, "ct-1").status, row(tables, "ct-2").blocked_by]).toEqual(["open", ["ct-1"]]);
  });

  test("the replacement's own edge to the old task just goes", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-1"] }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-5").blocked_by).toEqual([]);
    expect(row(tables, "ct-5").blocks ?? []).toEqual([]);
  });

  test("refuses itself, a done task, a parent with open subtasks, and a replacement that was itself superseded", async () => {
    const { ctx } = await makeCtx([
      task("ct-1"), task("ct-2", { status: "done" }), task("ct-3", { superseded_by: "ct-4" }), task("ct-4"),
      task("ct-6"), task("ct-7", { parent_id: "task_ct-6" }),
    ]);
    await expect(call(supersede, ctx, { short_id: "ct-6", by: "ct-4" })).rejects.toThrow(/open subtasks \(ct-7\)/);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-1" })).rejects.toThrow(/itself/);
    await expect(call(supersede, ctx, { short_id: "ct-2", by: "ct-4" })).rejects.toThrow(/done/);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-3" })).rejects.toThrow(/superseded by ct-4/);
  });
});

describe("duplicate (TG5)", () => {
  test("marking a duplicate moves its dependents to the canonical", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    expect(row(tables, "ct-1").duplicate_of).toBe("ct-7");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-2"]);
  });
});

describe("related (TG5)", () => {
  test("relate and unrelate write both rows and their history", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    await call(relate, ctx, { short_id: "ct-1", other: "ct-2" });
    await call(relate, ctx, { short_id: "ct-2", other: "ct-1" });
    expect([row(tables, "ct-1").related, row(tables, "ct-2").related]).toEqual([["ct-2"], ["ct-1"]]);
    expect(historyOf(tables, "ct-1", "related")).toEqual([["", "ct-2"]]);
    await call(unrelate, ctx, { short_id: "ct-2", other: "ct-1" });
    expect([row(tables, "ct-1").related, row(tables, "ct-2").related]).toEqual([[], []]);
  });

  test("unrelate removes a link whose far side is gone; relate refuses self and missing", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { related: ["ct-404"] })]);
    await call(unrelate, ctx, { short_id: "ct-1", other: "ct-404" });
    expect(row(tables, "ct-1").related).toEqual([]);
    await expect(call(relate, ctx, { short_id: "ct-1", other: "ct-1" })).rejects.toThrow(/itself/);
    await expect(call(relate, ctx, { short_id: "ct-1", other: "ct-404" })).rejects.toThrow(/not found/i);
  });
});
