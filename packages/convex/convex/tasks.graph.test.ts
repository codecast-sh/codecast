// The task graph on the server (docs/architecture/task-graph.md): readiness
// resolves blockers and parents the page dropped from the database (TG1), an
// edge that closes a loop is refused with its path (TG4), and every graph and
// label change writes task_history through one helper (TG11).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDep, create, list, removeDep, update, webList } from "./tasks";
import { get as getPlan, webGet as webGetPlan } from "./plans";
import { readinessLookups, stampGraphStatus } from "./lib/taskGraph";
import { isUnblocked } from "@codecast/shared/tasks";
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

  test("plans.webGet stamps each row's blockers, so the plan list's marks agree with /tasks", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "dropped" }),
      task("ct-2", { blocked_by: ["ct-1", "ct-3"], plan_id: "plan_1" }),
      task("ct-3", { status: "done", plan_id: "plan_1" }),
    ]);
    tables.plans = [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "P", status: "active", task_ids: ["task_ct-2", "task_ct-3"], created_at: 1, updated_at: 1 }];
    tables.managed_sessions = [];
    const plan = await (webGetPlan as any)._handler(ctx, { short_id: "pl-1" });
    expect(plan.tasks.find((t: any) => t.short_id === "ct-2").graph_status).toEqual([
      { ref: "ct-1", short_id: "ct-1", status: "dropped" },
      { ref: "ct-3", short_id: "ct-3", status: "done" },
    ]);
  });

  // A page can mix workspaces (the web's team view holds a viewer's private
  // rows routed to the team): an edge into another workspace stays unknown
  // even when the page holds the row, so every viewer judges it alike.
  test("a row the page holds in another workspace than its referrer reads as unknown", async () => {
    const team = { team_id: "team_t", workspace: "team:team_t" };
    const page: any[] = [
      task("ct-1", { ...team, status: "done" }),
      task("ct-2", { team_id: "team_t", workspace: `user:${USER}`, blocked_by: ["ct-1"] }),
      task("ct-3", { ...team, blocked_by: ["ct-1"] }),
    ];
    const { ctx } = await makeCtx(page.map((t) => ({ ...t })));
    await stampGraphStatus(ctx, page);
    expect(page[1].graph_status).toEqual([]);
    expect(page[2].graph_status).toEqual([{ ref: "ct-1", short_id: "ct-1", status: "done" }]);
    const lookupsFor = await readinessLookups(ctx, page);
    expect([isUnblocked(page[1], lookupsFor(page[1]).statusOf), isUnblocked(page[2], lookupsFor(page[2]).statusOf)]).toEqual([false, true]);
  });

  // A start that is told what still holds the task (TG1) must answer for the
  // edges the SAME write stored: `task` is the row as read before the patch,
  // so reading it alone omits a blocker this call just added.
  test("a start that also adds a blocker reports the blocker it wrote", async () => {
    const { ctx } = await makeCtx([
      task("ct-1"),
      task("ct-2"),
    ]);
    const result = await call(update, ctx, { short_id: "ct-2", status: "in_progress", blocked_by: ["ct-1"] });
    expect(result.open_blockers).toEqual([{ kind: "task", ref: "ct-1", status: "open" }]);
  });

  test("a start of a task whose only blocker finished reports none", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
    ]);
    const result = await call(update, ctx, { short_id: "ct-2", status: "in_progress" });
    expect(result.open_blockers).toEqual([]);
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
  const LOOP = "ct-3 already waits on ct-1 (ct-3 → ct-2 → ct-1, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-3 needs ct-1, that edge already exists.";

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
    const { ctx, tables } = await makeCtx(tasks);
    await call(addDep, ctx, { short_id: "ct-1", blocked_by: "ct-3" });
    expect(tables.tasks.find((t) => t.short_id === "ct-1").blocked_by).toContain("ct-3");
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

  // Readiness never reads across workspaces, so such a blocker would stay
  // unknown and hold the task forever; addDep already refused it.
  test("create and update refuse a dependency in another workspace; a ref naming nothing is kept", async () => {
    const foreign = task("ct-9", { user_id: "u_other", team_id: "team_x", workspace: "team:team_x" });
    const { ctx, tables } = await makeCtx([foreign, task("ct-1")]);
    tables.counters = [{ _id: "counter_ct", name: "ct", value: 20 }];
    const FORBIDDEN = "dependency task belongs to another workspace";
    await expect(call(create, ctx, { title: "New", blocked_by: ["ct-9"] })).rejects.toThrow(FORBIDDEN);
    await expect(call(update, ctx, { short_id: "ct-1", blocked_by: ["ct-9"] })).rejects.toThrow(FORBIDDEN);
    await expect(call(update, ctx, { short_id: "ct-1", blocks: ["ct-9"] })).rejects.toThrow(FORBIDDEN);
    await call(update, ctx, { short_id: "ct-1", blocked_by: ["ct-404"] });
  });

  // A stored ref that names no task reads as missing and blocks nothing, so
  // every ref is stored canonical, or as a wait, or refused (TG3).
  test("create and update store blocker refs canonical and refuse what is no task", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    tables.counters = [{ _id: "counter_ct", name: "ct", value: 20 }];
    const { short_id } = await call(create, ctx, { title: "New", blocked_by: ["CT-01", " ct-1 ", "task_ct-2"] });
    expect(tables.tasks.find((t) => t.short_id === short_id).blocked_by).toEqual(["ct-1", "task_ct-2"]);
    await call(update, ctx, { short_id: "ct-1", blocks: ["CT-002"] });
    expect(tables.tasks.find((t) => t.short_id === "ct-1").blocks).toEqual(["ct-2"]);
    await expect(call(create, ctx, { title: "Step", blocked_by: ["Design the schema"] })).rejects.toThrow("is not a blocker");
    await expect(call(update, ctx, { short_id: "ct-1", blocked_by: ["#42"] })).rejects.toThrow('"#42" is a wait, not a task: add it with cast task dep ct-1 --blocked-by "#42"');
    await expect(call(update, ctx, { short_id: "ct-1", blocks: ["sd-4"] })).rejects.toThrow('"sd-4" is not a task');
  });

  test("create turns a wait-shaped blocked_by ref into a wait, as an older CLI sends it", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")]);
    tables.counters = [{ _id: "counter_ct", name: "ct", value: 20 }];
    ctx.scheduler.runAt = async () => null;
    const { short_id } = await call(create, ctx, { title: "Later", blocked_by: ["ct-1", "2h"] });
    const row = tables.tasks.find((t) => t.short_id === short_id);
    expect(row.blocked_by).toEqual(["ct-1"]);
    expect(row.waits).toMatchObject([{ kind: "time", state: "waiting" }]);
  });

  test("a graph too large to walk whole is refused, not half checked", async () => {
    const wide = Array.from({ length: 2000 }, (_, i) => task(`ct-${i + 1}`, { blocked_by: ["ct-5000"] }));
    const { ctx } = await makeCtx([...wide, task("ct-5000"), task("ct-6000")]);
    await expect(call(update, ctx, { short_id: "ct-6000", blocked_by: wide.map((t) => t.short_id) }))
      .rejects.toThrow("Cannot check ct-6000's dependencies for a loop: more than 2000 open tasks wait behind it.");
  });

  test("create refuses blockers that already wait on the id it takes", async () => {
    // The counter hands out ct-2, which ct-1 already names as its blocker.
    const { ctx, tables } = await makeCtx([task("ct-1", { blocked_by: ["ct-2"] })]);
    tables.counters = [{ _id: "counter_ct", name: "ct", value: 1 }];
    await expect(call(create, ctx, { title: "New", blocked_by: ["ct-1"] }))
      .rejects.toThrow("ct-1 already waits on ct-2 (ct-1 → ct-2, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-1 needs ct-2, that edge already exists.");
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
