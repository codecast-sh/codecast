// Links that do not block (docs/architecture/task-graph.md TG5): found_during
// fills itself from the creating session's bound task, superseding and
// marking a duplicate move the old task's dependents to the replacement (and
// refuse a loop) and reopening or unmarking moves them back, related is
// mirrored on both rows, and every link reaches `cast task show`/`context`
// resolved.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { context, create, get, updateTaskAs } from "./tasks";
import { relate, supersede, unrelate, webFoundHere } from "./taskLinks";
import { hashToken } from "./apiTokens";
import { dispatch } from "./dispatch";
import { createFromTemplate } from "./plans";

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
const commentsOn = (tables: any, id: string) => tables.task_comments.filter((c: any) => c.task_id === `task_${id}`).map((c: any) => c.text);
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

  test("show lists every blocker with its live state, done, gone and another workspace's alike", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done", blocks: ["ct-4"] }),
      task("ct-2", { workspace: `user:${OTHER}`, user_id: OTHER }),
      task("ct-4", { blocked_by: ["ct-1", "task_ct-1", "ct-9", "ct-2"], blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-4"] }),
    ]);
    const shown = await call(get, ctx, { short_id: "ct-4" });
    expect(shown.links.blocked_by).toEqual([
      { short_id: "ct-1", title: "Title ct-1", status: "done" },
      { short_id: "ct-9", status: "missing", missing: true },
      { short_id: "ct-2", status: "unknown" },
    ]);
    expect(shown.links.blocks).toEqual([{ short_id: "ct-5", title: "Title ct-5", status: "open" }]);
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
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual([]);
    expect(row(tables, "ct-5").blocked_by).toEqual([]);
    expect(row(tables, "ct-5").blocks ?? []).toEqual([]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-1")).toEqual(["Superseded by ct-5."]);
    // That edge was its last blocker, so it is released and told.
    expect(commentsOn(tables, "ct-5")).toEqual(["Unblocked: ct-1 superseded by ct-5"]);
  });

  test("a blocks entry whose task no longer waits on the old task gains no edge and is dropped", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: [] }),
      task("ct-3", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual(["ct-3"]);
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(historyOf(tables, "ct-2", "blocked_by")).toEqual([]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-3"]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
  });

  test("a done replacement releases the moved dependents and tells them", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-9"] }),
      task("ct-5", { status: "done" }),
      task("ct-9"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(commentsOn(tables, "ct-2")).toEqual(["Unblocked: ct-1 superseded by ct-5"]);
    // Still waits on ct-9.
    expect(commentsOn(tables, "ct-3")).toEqual([]);
  });

  test("superseding an already dropped task re-blocks without an unblocked note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5", { status: "done" }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("superseding a dropped task tells a released dependent it is blocked again", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(commentsOn(tables, "ct-2")).toEqual(["Blocked again: ct-1 superseded by ct-5, so it waits on ct-5"]);
  });

  test("a dependent that already names the replacement by _id gains no second edge", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "task_ct-5"] }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["task_ct-5"]);
  });

  test("reopening a superseded task clears superseded_by and takes its dependents back", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-5"] }),
      task("ct-5", { blocks: ["ct-3"] }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    const old = row(tables, "ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual(["open", undefined, ["ct-3", "ct-2"]]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    // It waited on the replacement before the move too, so it keeps it.
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-5", "ct-1"]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-3"]);
    expect(historyOf(tables, "ct-1", "superseded_by")).toEqual([["", "ct-5"], ["ct-5", ""]]);
  });

  test("a supersede from a session is recorded as the agent's", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5", conversation_id: SESSION });
    const h = tables.task_history.find((r: any) => r.field === "superseded_by");
    expect([h.actor_type, h.conversation_id]).toEqual(["agent", "conv_1"]);
  });

  test("a dependent missing from the blocks mirror is found through the plan and moved", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { plan_id: "plan_1" }),
      task("ct-2", { plan_id: "plan_1", blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual(["ct-2"]);
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-5").blocks]).toEqual([["ct-5"], ["ct-2"]]);
  });

  test("a plan made from a template writes the blocks mirror, so superseding its blocker moves the dependent", async () => {
    const { ctx, tables } = await makeCtx([task("ct-5")]);
    tables.plan_templates = [{
      _id: "tpl_1", user_id: USER, name: "T", goal_template: "G",
      task_templates: [{ title: "First" }, { title: "Second", blocked_by_indices: [0] }],
    }];
    await call(createFromTemplate, ctx, { template_id: "tpl_1" });
    const [first, second] = tables.tasks.filter((t: any) => t.source === "template");
    expect(first.blocks).toEqual([second.short_id]);
    await call(supersede, ctx, { short_id: first.short_id, by: "ct-5" });
    expect(row(tables, second.short_id).blocked_by).toEqual(["ct-5"]);
  });

  test("reopening when the edge back would close a loop leaves that dependent on the replacement and says so", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    row(tables, "ct-1").blocked_by = ["ct-2"];
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    expect([row(tables, "ct-1").status, row(tables, "ct-2").blocked_by]).toEqual(["open", ["ct-5"]]);
    expect(commentsOn(tables, "ct-2")[0]).toMatch(/^Still waits on ct-5: ct-1 was reopened, but waiting on ct-1 again was refused\. .*loop/);
  });

  test("a task already superseded by another is refused until reopened", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
      task("ct-6"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-6" })).rejects.toThrow(/already superseded by ct-5/);
    expect(row(tables, "ct-1").superseded_by).toBe("ct-5");
  });

  test("refuses itself, a done task, a parent with open subtasks, and a replacement that was itself superseded", async () => {
    const { ctx } = await makeCtx([
      task("ct-1"), task("ct-2", { status: "done" }), task("ct-3", { superseded_by: "ct-4" }), task("ct-4"),
      task("ct-6"), task("ct-7", { parent_id: "task_ct-6" }), task("ct-8", { status: "dropped" }),
    ]);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-8" })).rejects.toThrow(/ct-8 is dropped/);
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

  test("marked with a drop in one write, the moved dependents get no unblocked note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("a done canonical releases the moved dependents with a note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    expect(commentsOn(tables, "ct-2")).toEqual(["Unblocked: ct-1 duplicate of ct-7"]);
  });

  test("a done duplicate keeps its released dependents where they are", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "done", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    expect(row(tables, "ct-1").duplicate_of).toBe("ct-7");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-7").blocks ?? []).toEqual([]);
  });

  test("undoing a mark (clear plus reopen in one write) puts the dependents back", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "", status: "open" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-1").blocks).toEqual(["ct-2"]);
    expect(row(tables, "ct-7").blocks).toEqual([]);
  });

  test("undone as two writes (reopen, then clear), a released dependent is blocked again and told", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-7").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-2")).toEqual([
      "Unblocked: ct-1 duplicate of ct-7",
      "Blocked again: ct-1 was reopened, so it waits on ct-1",
    ]);
  });

  test("a mark cleared on an open task takes the dependents back; on a closed one they stay", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-3"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-3", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-3", duplicate_of: "" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7"]);
  });

  test("undoing one of two duplicates folded into one canonical keeps the other's edge", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-4"] }),
      task("ct-2", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-1", "ct-2"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-2", duplicate_of: "ct-7", status: "dropped" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7"]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "", status: "open" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7", "ct-1"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-4"]);
  });

  test("a dropped or replaced canonical is refused and nothing moves", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "dropped" }),
      task("ct-8", { superseded_by: "ct-9" }),
      task("ct-9"),
    ]);
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" })).rejects.toThrow(/ct-7 is dropped/);
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-8" })).rejects.toThrow(/superseded by ct-9/);
    expect([row(tables, "ct-1").duplicate_of, row(tables, "ct-2").blocked_by]).toEqual([undefined, ["ct-1"]]);
  });

  test("a canonical in another workspace is refused and nothing moves", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-9", { user_id: OTHER, team_id: "team_x", workspace: "team:team_x" }),
    ]);
    tables.team_memberships = [{ _id: "m1", user_id: USER, team_id: "team_x", role: "member" }];
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-9", status: "dropped" })).rejects.toThrow(/another workspace/);
    expect([row(tables, "ct-1").status, row(tables, "ct-1").duplicate_of, row(tables, "ct-2").blocked_by]).toEqual(["open", undefined, ["ct-1"]]);
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
    await expect(call(unrelate, ctx, { short_id: "ct-1", other: "task_ct-404" })).rejects.toThrow(/ct-1 is not related to task_ct-404/);
  });
});

describe("web side effects (dispatch)", () => {
  const run = (ctx: any, action: string, args: unknown[]) => (dispatch as any)._handler(ctx, { action, args });

  test("relateTasks, unrelateTasks and supersedeTask take the tuples the store sends", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] }), task("ct-5"), task("ct-6")]);
    await run(ctx, "relateTasks", ["ct-5", "ct-6"]);
    expect([row(tables, "ct-5").related, row(tables, "ct-6").related]).toEqual([["ct-6"], ["ct-5"]]);
    await run(ctx, "unrelateTasks", ["ct-6", "ct-5"]);
    expect([row(tables, "ct-5").related, row(tables, "ct-6").related]).toEqual([[], []]);
    // A note the person left empty arrives as null, never undefined.
    const res = await run(ctx, "supersedeTask", ["ct-1", "ct-5", null]);
    expect(res).toEqual({ short_id: "ct-1", superseded_by: "ct-5", moved: ["ct-2"] });
    expect(commentsOn(tables, "ct-1")).toEqual(["Superseded by ct-5. Its dependents now wait on it: ct-2."]);
    expect(tables.task_history.filter((h: any) => h.field === "superseded_by").map((h: any) => h.actor_type)).toEqual(["user"]);
  });
});
