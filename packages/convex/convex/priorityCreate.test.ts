// Priorities and plans a person names, and tasks filed under a work item
// (priorityCreate.ts): `cast priorities create`, `cast plan create
// --from-call` and `cast task create --under ct-N|pl-N|pri-N`.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { dmRoomKey } from "@codecast/shared/contracts";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";

setDefaultTimeout(60_000);

const pri = (api as any).priorities;
const TOKEN = "cc_test_priority_create_ben";
const NOW = Date.now();

const backends: any[] = [];
afterEach(async () => {
  for (const t of backends.splice(0)) await t.finishAllScheduledFunctions?.(() => {}).catch?.(() => {});
});

/** Ana and Ben share team T (calls and priorities on); Cat is in team O; Ben is also in team Off, where priorities is off. Ben holds the token. */
async function world() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: NOW, features: { calls: true, priorities: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: NOW, features: { priorities: true } } as any);
    const off = await ctx.db.insert("teams", { name: "Off", created_at: NOW } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", github_username: "ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", github_username: "ben" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat", github_username: "cat" } as any);
    for (const [u, tm] of [[ana, team], [ben, team], [cat, other], [ben, off]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: tm, role: "member", joined_at: NOW } as any);
    }
    await ctx.db.insert("api_tokens", { user_id: ben, token_hash: await hashToken(TOKEN), name: "cli", created_at: NOW, last_used_at: NOW } as any);
    const call = await ctx.db.insert("transcripts", {
      room_key: dmRoomKey(String(ana), String(ben)), team_id: team, started_by: ana, status: "ended", started_at: NOW - 60_000, ended_at: NOW,
      routes: [], last_seq: 0, short_id: "cl-7", participants: [{ id: String(ana), name: "Ana" }, { id: String(ben), name: "Ben" }],
    } as any);
    return { team, other, off, ana, ben, cat, call, ws: `team:${team}` };
  });
  const priority = (short_id: string) => t.run(async (ctx: any) => await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first());
  const task = (short_id: string) => t.run(async (ctx: any) => await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first());
  const create = (args: Record<string, unknown>) => t.mutation(pri.cliCreate, { api_token: TOKEN, team_id: ids.team, ...args } as any);
  const createTask = (args: Record<string, unknown>) => t.mutation(api.tasks.create, { api_token: TOKEN, workspace: "team", team_id: ids.team, ...args } as any);
  return { t, ...ids, priority, task, create, createTask };
}

describe("cast priorities create", () => {
  test("files an active priority for the caller, last in their order, with its call", async () => {
    const { create, priority, ben, ws, call } = await world();
    const first = await create({ title: "  Ship the board  ", summary: "Scribe titles frames", from_call: "cl-7" });
    expect(first).toEqual({ short_id: "pri-1", title: "Ship the board", owner_id: ben });
    const row = await priority("pri-1");
    expect(row).toMatchObject({ user_id: ben, workspace: ws, status: "active", summary: "Scribe titles frames", steps: [], session_count: 0, step_key_max: 0, from_call: call, ai_rank: 1, pass_at: 0 });
    expect(row.person_pos).toBeUndefined();
    await create({ title: "Second" });
    expect((await priority("pri-2")).ai_rank).toBe(2);
  });

  test("names a teammate as owner by handle, placed in their own order", async () => {
    const { create, priority, ana, ws } = await world();
    await create({ title: "Mine" });
    expect((await create({ title: "Ana's", owner: "@ana" })).owner_id).toBe(ana);
    expect(await priority("pri-2")).toMatchObject({ user_id: ana, workspace: ws, ai_rank: 1 });
  });

  test("refuses a workspace the caller is not in, an owner outside it, a personal priority for someone else, and a team with priorities off", async () => {
    const { create, other, off, t } = await world();
    expect(await create({ title: "x", team_id: other })).toEqual({ error: "you are not a member of that workspace" });
    expect(await create({ title: "x", owner: "@cat" })).toEqual({ error: "nobody in this team answers to @cat" });
    expect((await create({ title: "x", team_id: undefined, personal: true, owner: "@ana" })).error).toContain("a personal priority is your own");
    expect(await create({ title: "x", team_id: off })).toEqual({ error: teamFeatureOffMessage("priorities") });
    expect(await create({ title: "x", team_id: undefined })).toEqual({ error: "name a workspace: a team, or personal" });
    expect(await create({ title: "   " })).toEqual({ error: "a priority needs a title" });
    expect(await t.run(async (ctx: any) => (await ctx.db.query("priorities").collect()).length)).toBe(0);
  });

  test("a call the caller cannot read is refused", async () => {
    const { create } = await world();
    await expect(create({ title: "x", from_call: "cl-99" })).rejects.toThrow("Call not found: cl-99");
  });
});

describe("cast plan create --from-call", () => {
  test("links the plan to the call", async () => {
    const { t, call } = await world();
    const made = await t.mutation(api.plans.create, { api_token: TOKEN, title: "Board follow-ups", from_call: "cl-7" } as any);
    const plan = await t.run(async (ctx: any) => await ctx.db.query("plans").withIndex("by_short_id", (q: any) => q.eq("short_id", made.short_id)).first());
    expect(plan.from_call).toBe(call);
  });
});

describe("cast task create --under", () => {
  test("ct-N makes a subtask and pl-N a task of the plan", async () => {
    const { t, ben, ws, createTask, task } = await world();
    const parent = await createTask({ title: "Parent" });
    const sub = await createTask({ title: "Sub", parent_id: parent.short_id });
    expect((await task(sub.short_id)).parent_id).toBe(parent.id);

    const planId = await t.run(async (ctx: any) => ctx.db.insert("plans", {
      user_id: ben, workspace: ws, short_id: "pl-50", title: "Plan", status: "active", source: "human", task_ids: [], progress: { total: 0, done: 0, in_progress: 0, open: 0 },
    }));
    const inPlan = await createTask({ title: "In plan", plan_id: "pl-50" });
    expect((await task(inPlan.short_id)).plan_id).toBe(planId);
    expect((await t.run(async (ctx: any) => ctx.db.get(planId))).task_ids).toEqual([inPlan.id]);
  });

  test("pri-N appends a critical milestone naming the task, its key after every key spent", async () => {
    const { t, create, createTask, priority } = await world();
    await create({ title: "Ship the board", owner: "@ana" });
    await t.run(async (ctx: any) => {
      const p = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", "pri-1")).first();
      await ctx.db.patch(p._id, { steps: [{ key: "s2", title: "Old", tier: "polish", tier_set_by: "pass", refs: [], done: false }], step_key_max: 4 });
    });
    const made = await createTask({ title: "Draw frames", under_priority: "PRI-1" });
    const p = await priority("pri-1");
    expect(p.steps.at(-1)).toEqual({ key: "s5", title: "Draw frames", tier: "critical", tier_set_by: "person", refs: [{ kind: "task", id: made.short_id }], done: false });
    expect(p.steps).toHaveLength(2);
    expect(p.step_key_max).toBe(5);
  });

  test("a priority in another workspace, an unknown one, or a merged one files no task", async () => {
    const { t, create, createTask, cat, other } = await world();
    await create({ title: "Team priority" });
    await t.run(async (ctx: any) => {
      await ctx.db.insert("priorities", {
        user_id: cat, workspace: `team:${other}`, short_id: "pri-40", title: "Theirs", summary: "", status: "active", steps: [],
        first_seen_at: NOW, last_active_at: NOW, pass_at: 0, created_at: NOW, updated_at: NOW,
      });
      const p = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", "pri-1")).first();
      const { _id, _creationTime, ...fields } = p;
      await ctx.db.insert("priorities", { ...fields, short_id: "pri-41", status: "merged", merged_into: _id });
    });
    await expect(createTask({ title: "x", under_priority: "pri-40" })).rejects.toThrow("Priority not found: pri-40");
    await expect(createTask({ title: "x", under_priority: "pri-404" })).rejects.toThrow("Priority not found: pri-404");
    await expect(createTask({ title: "x", under_priority: "pri-41" })).rejects.toThrow("pri-41 was merged");
    await expect(createTask({ title: "x", workspace: "personal", team_id: undefined, under_priority: "pri-1" })).rejects.toThrow("pri-1 is in another workspace than this task");
    expect(await t.run(async (ctx: any) => (await ctx.db.query("tasks").collect()).length)).toBe(0);
  });
});
