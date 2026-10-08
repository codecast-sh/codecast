// The task graph on the server (docs/architecture/task-graph.md): readiness
// resolves blockers and parents the page dropped from the database (TG1), an
// edge that closes a loop is refused with its path (TG4), and every graph and
// label change writes task_history through one helper (TG11).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDep, create, getReadyTasks, list, removeDep, update, webList } from "./tasks";
import { get as getPlan } from "./plans";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const TOKEN = "task-graph-test-token";

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    tasks,
    task_history: [],
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
      db: makeFakeDb(tables),
      scheduler: { runAfter: async () => null },
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

const ids = (rows: any[]) => rows.map((t) => t.short_id).sort();
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, { api_token: TOKEN, ...args });

describe("ready (TG1)", () => {
  // The bug: list's page drops done tasks before the ready filter, which then
  // looked each blocker up in that page, so a finished blocker never cleared.
  test("cast task ready lists a task whose blocker finished", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-4"] }),
      task("ct-4"),
    ]);
    expect(ids(await call(list, ctx, { ready: true }))).toEqual(["ct-2", "ct-4"]);
  });

  test("a blocker the filters dropped is read, not assumed: open blocks, dropped clears", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { labels: ["other"] }),
      task("ct-2", { labels: ["x"], blocked_by: ["ct-1"] }),
      task("ct-3", { status: "dropped", labels: ["other"] }),
      task("ct-4", { labels: ["x"], blocked_by: ["ct-3"] }),
    ]);
    expect(ids(await call(list, ctx, { ready: true, label: "x" }))).toEqual(["ct-4"]);
  });

  test("a blocker that names nothing does not block; an _id ref resolves by _id", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-999"] }),
      task("ct-3", { blocked_by: ["task_ct-1"] }),
      task("ct-5"),
      task("ct-4", { blocked_by: ["task_ct-5"] }),
    ]);
    expect(ids(await call(list, ctx, { ready: true }))).toEqual(["ct-2", "ct-3", "ct-5"]);
  });

  test("a subtask of a parent being worked waits unless subtasks are asked for", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "in_progress" }),
      task("ct-2", { parent_id: "task_ct-1" }),
    ]);
    expect(ids(await call(list, ctx, { ready: true }))).toEqual([]);
    const withSubtasks = await call(list, ctx, { ready: true, include_subtasks: true });
    expect(ids(withSubtasks)).toEqual(["ct-2"]);
    expect(withSubtasks[0].parent_short_id).toBe("ct-1");
  });

  // The CLI tags a row blocked from what the server says still holds it, never
  // from the raw blocked_by, which keeps naming a blocker after it finished.
  test("every listed row carries its verdict and its open blockers", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-2", "ct-404"] }),
    ]);
    const rows = await call(list, ctx, {});
    const by = (id: string) => rows.find((t: any) => t.short_id === id);
    expect([by("ct-2").ready, by("ct-2").open_blockers]).toEqual([true, []]);
    expect([by("ct-3").ready, by("ct-3").open_blockers]).toEqual([false, [{ kind: "task", ref: "ct-2", status: "open" }]]);
  });

  test("a blocker in another workspace is never read: it stays unknown and blocks", async () => {
    const OTHER = "u_other";
    const { ctx } = await makeCtx([
      task("ct-9", { status: "done", user_id: OTHER, team_id: "team_x", workspace: "team:team_x" }),
      task("ct-2", { blocked_by: ["ct-9"] }),
    ]);
    const rows = await call(list, ctx, {});
    expect(rows.map((t: any) => [t.short_id, t.ready, t.open_blockers])).toEqual([["ct-2", false, [{ kind: "task", ref: "ct-9", status: "unknown" }]]]);
    expect(ids(await call(list, ctx, { ready: true }))).toEqual([]);
  });

  test("plans.get returns the blockers and parents its tasks name outside the plan", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-1", "ct-404"], plan_id: "plan_1" }),
    ]);
    tables.plans = [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "P", status: "active", task_ids: ["task_ct-2"], created_at: 1, updated_at: 1 }];
    const plan = await call(getPlan, ctx, { short_id: "pl-1" });
    expect(plan.graph_outside).toEqual({ tasks: [{ _id: "task_ct-1", short_id: "ct-1", status: "done" }], searched: ["ct-1", "ct-404"] });
  });

  test("getReadyTasks applies the same rule", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-2"] }),
      task("ct-4", { triage_status: "suggested" }),
      task("ct-5", { status: "in_review" }),
      task("ct-6", { parent_id: "task_ct-5" }),
    ]);
    expect(ids(await call(getReadyTasks, ctx, {}))).toEqual(["ct-2"]);
  });

  test("webList ready reads the finished blocker its status filter dropped", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done" }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-2"] }),
    ]);
    const { items } = await (webList as any)._handler(ctx, { ready: true, status: "open" });
    expect(ids(items)).toEqual(["ct-2"]);
  });
});

describe("edges that cannot loop (TG4)", () => {
  // ct-1 <- ct-2 <- ct-3: ct-3 waits on ct-2, which waits on ct-1.
  const chain = () => [
    task("ct-1", { blocks: ["ct-2"] }),
    task("ct-2", { blocked_by: ["ct-1"], blocks: ["ct-3"] }),
    task("ct-3", { blocked_by: ["ct-2"] }),
  ];
  const LOOP = "ct-3 already waits on ct-1 (ct-1 → ct-2 → ct-3); this edge would close a loop.";

  test("addDep --blocked-by refuses the closing edge and names the path", async () => {
    const { ctx, tables } = await makeCtx(chain());
    await expect(call(addDep, ctx, { short_id: "ct-1", blocked_by: "ct-3" })).rejects.toThrow(LOOP);
    expect(tables.tasks.find((t) => t.short_id === "ct-1").blocked_by).toBeUndefined();
  });

  test("addDep --blocks refuses it from the other side", async () => {
    const { ctx } = await makeCtx(chain());
    await expect(call(addDep, ctx, { short_id: "ct-3", blocks: "ct-1" })).rejects.toThrow(LOOP);
  });

  test("a task cannot wait on itself", async () => {
    const { ctx } = await makeCtx(chain());
    await expect(call(addDep, ctx, { short_id: "ct-2", blocked_by: "ct-2" })).rejects.toThrow("ct-2 cannot wait on itself.");
  });

  test("a finished task in the chain holds nothing back, so the edge is allowed", async () => {
    const tasks = chain();
    tasks[1].status = "done";
    const { ctx } = await makeCtx(tasks);
    await call(addDep, ctx, { short_id: "ct-1", blocked_by: "ct-3" });
  });

  test("update refuses a loop through blocked_by and through blocks", async () => {
    const { ctx } = await makeCtx(chain());
    await expect(call(update, ctx, { short_id: "ct-1", blocked_by: ["ct-3"] })).rejects.toThrow(LOOP);
    await expect(call(update, ctx, { short_id: "ct-3", blocks: ["ct-1"] })).rejects.toThrow(LOOP);
    // Edges already on the row are not re-judged.
    await call(update, ctx, { short_id: "ct-3", blocked_by: ["ct-2"] });
  });

  test("update judges a task private inside a team by its access key, as addDep does", async () => {
    const privateInTeam = { team_id: "team_t", workspace: `user:${USER}` };
    const { ctx } = await makeCtx(chain().map((t) => ({ ...t, ...privateInTeam })));
    await expect(call(update, ctx, { short_id: "ct-1", blocked_by: ["ct-3"] })).rejects.toThrow(LOOP);
  });

  test("create refuses blockers that already wait on the id it takes", async () => {
    // The counter hands out ct-2, which ct-1 already names as its blocker.
    const { ctx, tables } = await makeCtx([task("ct-1", { blocked_by: ["ct-2"] })]);
    tables.counters = [{ _id: "counter_ct", name: "ct", value: 1 }];
    await expect(call(create, ctx, { title: "New", blocked_by: ["ct-1"] }))
      .rejects.toThrow("ct-1 already waits on ct-2 (ct-2 → ct-1); this edge would close a loop.");
  });
});

describe("history (TG11)", () => {
  const rows = (tables: any, field: string) => tables.task_history.filter((h: any) => h.field === field);

  test("addDep and removeDep record the blocked task's blocked_by, whichever side was named", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    await call(addDep, ctx, { short_id: "ct-2", blocked_by: "ct-1" });
    await call(removeDep, ctx, { short_id: "ct-1", blocks: "ct-2" });
    expect(rows(tables, "blocked_by").map((h: any) => [h.task_id, h.old_value, h.new_value, h.actor_type])).toEqual([
      ["task_ct-2", "", "ct-1", "user"],
      ["task_ct-2", "ct-1", "", "user"],
    ]);
  });

  test("update records labels and blocked_by, and skips a write that changed nothing", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { labels: ["a"] }), task("ct-2")]);
    await call(update, ctx, { short_id: "ct-1", labels: ["a", "b"], blocked_by: ["ct-2"] });
    await call(update, ctx, { short_id: "ct-1", labels: ["a", "b"] });
    expect(rows(tables, "labels").map((h: any) => [h.old_value, h.new_value])).toEqual([["a", "a, b"]]);
    expect(rows(tables, "blocked_by").map((h: any) => [h.old_value, h.new_value])).toEqual([["", "ct-2"]]);
  });

  test("status keeps the row shape it always had", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")]);
    await call(update, ctx, { short_id: "ct-1", status: "in_progress" });
    const [row] = rows(tables, "status");
    expect(row).toMatchObject({ task_id: "task_ct-1", user_id: USER, actor_type: "user", action: "updated", old_value: "open", new_value: "in_progress" });
  });
});
