// `cast plan template save|ls|rm` (docs/architecture/task-graph.md TG6): a
// plan's live steps and edges become a template whose blockers all point
// back, saving a name again replaces it, and only its author removes it.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { list, remove, save } from "./planTemplates";
import { hashToken } from "./apiTokens";

const USER = "u_user";
const OTHER = "u_other";
const TOKEN = "plan-templates-test-token";
const OTHER_TOKEN = "plan-templates-other-token";

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  title: `Title ${shortId}`,
  status: "open",
  priority: "medium",
  task_type: "task",
  created_at: 1,
  updated_at: 1,
  ...over,
});

async function makeCtx(tasks: any[]) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: OTHER, name: "Other" }],
    api_tokens: [
      { _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) },
      { _id: "token_2", user_id: OTHER, token_hash: await hashToken(OTHER_TOKEN) },
    ],
    plans: [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "Ship the thing", goal: "Shipped", task_ids: tasks.map((t) => t._id) }],
    tasks,
    team_memberships: [],
    plan_templates: [],
  };
  return { ctx: { db: makeFakeDb(tables) } as any, tables };
}

const call = (fn: any, ctx: any, args: any, token = TOKEN) => fn._handler(ctx, { api_token: token, ...args });

describe("plan templates (TG6)", () => {
  test("save orders steps so every blocker points back, and leaves dropped steps out", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-3", { blocked_by: ["ct-1", "ct-2"], description: "Review it" }),
      task("ct-1"),
      task("ct-2", { blocked_by: ["task_ct-1", "ct-40"] }),
      task("ct-4", { status: "dropped", blocked_by: ["ct-3"] }),
    ]);
    const result = await call(save, ctx, { plan: "pl-1" });
    expect(result).toMatchObject({ name: "Ship the thing", steps: 3, edges: 3, replaced: false });
    const [tpl] = tables.plan_templates;
    expect(tpl.goal_template).toBe("Shipped");
    expect(tpl.task_templates.map((t: any) => [t.title, t.blocked_by_indices ?? []])).toEqual([
      ["Title ct-1", []],
      ["Title ct-2", [0]],
      ["Title ct-3", [0, 1]],
    ]);
    expect(tpl.task_templates[2].description).toBe("Review it");
    expect(tpl.team_id).toBeUndefined();
  });

  test("saving the same name replaces it; list and remove see it, only for its author", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")]);
    await call(save, ctx, { plan: "pl-1", name: "Release" });
    const again = await call(save, ctx, { plan: "pl-1", name: "Release", description: "Weekly" });
    expect(again.replaced).toBe(true);
    expect(tables.plan_templates).toHaveLength(1);
    expect((await call(list, ctx, {})).map((t: any) => [t.name, t.description])).toEqual([["Release", "Weekly"]]);
    expect(await call(list, ctx, {}, OTHER_TOKEN)).toEqual([]);
    await expect(call(remove, ctx, { name: "release" }, OTHER_TOKEN)).rejects.toThrow(/No template of yours/);
    expect(await call(remove, ctx, { name: "release" })).toEqual({ removed: 1 });
    expect(tables.plan_templates).toHaveLength(0);
  });

  test("a plan the caller cannot read, or one with no live steps, saves nothing", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { status: "dropped" })]);
    await expect(call(save, ctx, { plan: "pl-1" }, OTHER_TOKEN)).rejects.toThrow(/Plan not found/);
    await expect(call(save, ctx, { plan: "pl-1" })).rejects.toThrow(/no steps to save/);
    expect(tables.plan_templates).toHaveLength(0);
  });

  test("a dropped step passes its blockers through, so its dependents keep their order", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2", { status: "dropped", blocked_by: ["ct-1"] }), task("ct-3", { blocked_by: ["ct-2"] })]);
    await call(save, ctx, { plan: "pl-1" });
    expect(tables.plan_templates[0].task_templates.map((t: any) => [t.title, t.blocked_by_indices ?? []])).toEqual([
      ["Title ct-1", []],
      ["Title ct-3", [0]],
    ]);
  });

  test("names match in any case; a name in two workspaces is removed from the one --team names", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")]);
    await call(save, ctx, { plan: "pl-1", name: "Release" });
    expect((await call(save, ctx, { plan: "pl-1", name: "RELEASE" })).replaced).toBe(true);
    expect(tables.plan_templates).toHaveLength(1);
    tables.plan_templates.push({ ...tables.plan_templates[0], _id: "tpl_team", team_id: "team_1" });
    await expect(call(remove, ctx, { name: "release" })).rejects.toThrow(/in 2 workspaces; pass --team/);
    expect(await call(remove, ctx, { name: "release", workspace: "team", team_id: "team_1" })).toEqual({ removed: 1 });
    expect(tables.plan_templates.map((t: any) => t.team_id)).toEqual([undefined]);
    expect(await call(remove, ctx, { name: "release" })).toEqual({ removed: 1 });
  });
});
