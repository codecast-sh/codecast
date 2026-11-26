// The web's priority controls ride dispatch (web store/prioritiesSlice) to the
// API's own mutations (priorities.ts): a move, a step's tier, set aside and
// restore land as the person's, and someone else's priority is refused.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const NOW = Date.now();
const step = (key: string, tier: "critical" | "polish") => ({ key, title: `Step ${key}`, tier, tier_set_by: "pass" as const, refs: [], done: false });

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: acme, role: "member", joined_at: 1 } as any);
    const insert = (short_id: string, ai_rank: number, steps: any[] = []) => ctx.db.insert("priorities", {
      user_id: ada, workspace: `team:${acme}`, short_id, title: short_id, summary: "", status: "active", ai_rank,
      steps, first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
    } as any);
    const p1 = await insert("pri-1", 1, [step("s1", "critical")]);
    const p2 = await insert("pri-2", 2);
    // A teammate reads a priority through a session of it shared with the team.
    await ctx.db.insert("conversations", {
      user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "shared", short_id: "jx7sh01", title: "shared",
      started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p2,
    } as any);
    return { ada, bea, acme, p1, p2 };
  });
  return { t, ...ids };
}

const dispatch = (t: any, user: string, action: string, args: unknown[]) =>
  t.withIdentity({ subject: `${user}|session` }).mutation(api.dispatch.dispatch, { action, args });

describe("priority controls ride dispatch", () => {
  test("a move (to a position, up or down), tier, set aside and restore land as the owner's", async () => {
    const { t, ada, p1, p2 } = await world();
    await dispatch(t, ada, "movePriority", ["pri-2", 1]);
    await dispatch(t, ada, "setPriorityStepTier", ["pri-1", "s1", "polish"]);
    let [one, two] = await t.run(async (ctx: any) => [await ctx.db.get(p1), await ctx.db.get(p2)]);
    expect([one.person_pos, two.person_pos]).toEqual([undefined, 0]);
    await dispatch(t, ada, "movePriority", ["pri-1", "up"]);
    [one] = await t.run(async (ctx: any) => [await ctx.db.get(p1)]);
    expect(one.person_pos).toBe(-1);
    await dispatch(t, ada, "movePriority", ["pri-1", "down"]);
    [one] = await t.run(async (ctx: any) => [await ctx.db.get(p1)]);
    expect(one.person_pos).toBe(1);
    expect([one.steps[0].tier, one.steps[0].tier_set_by]).toEqual(["polish", "person"]);
    await dispatch(t, ada, "setPriorityAside", ["pri-1"]);
    [one] = await t.run(async (ctx: any) => [await ctx.db.get(p1)]);
    expect(one.status).toBe("set_aside");
    await dispatch(t, ada, "restorePriority", ["pri-1"]);
    [one] = await t.run(async (ctx: any) => [await ctx.db.get(p1)]);
    expect(one.status).toBe("active");
  });

  test("a milestone's done, rename and drop, a priority's done and merge land as the owner's", async () => {
    const { t, ada, p1, p2 } = await world();
    await t.run(async (ctx: any) => ctx.db.patch(p1, { steps: [step("s1", "critical"), step("s2", "critical")] }));
    await dispatch(t, ada, "setPriorityStepDone", ["pri-1", "s1", true]);
    await dispatch(t, ada, "renamePriorityStep", ["pri-1", "s2", "Ship it"]);
    let one = await t.run(async (ctx: any) => ctx.db.get(p1));
    expect([one.steps[0].done, one.steps[0].done_set_by, one.steps[1].title, one.steps[1].title_set_by]).toEqual([true, "person", "Ship it", "person"]);
    await dispatch(t, ada, "dropPriorityStep", ["pri-1", "s2"]);
    one = await t.run(async (ctx: any) => ctx.db.get(p1));
    expect(one.steps[1].dropped).toBe(true);
    await dispatch(t, ada, "mergePriority", ["pri-1", "pri-2"]);
    const [merged, two] = await t.run(async (ctx: any) => [await ctx.db.get(p1), await ctx.db.get(p2)]);
    expect([merged.status, merged.status_set_by, two.steps.length]).toEqual(["merged", "person", 2]);
    await dispatch(t, ada, "markPriorityDone", ["pri-2"]);
    const done = await t.run(async (ctx: any) => ctx.db.get(p2));
    expect([done.status, done.status_set_by]).toEqual(["done", "person"]);
  });

  test("a session's move and not-this, a correction and its delete land as the owner's", async () => {
    const { t, ada, acme, p1, p2 } = await world();
    const conv = await t.run(async (ctx: any) => ctx.db.insert("conversations", {
      user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "own", short_id: "jx7own1", title: "own",
      started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p2,
    } as any));
    await dispatch(t, ada, "movePrioritySession", ["jx7own1", "pri-2", "pri-1", "s1"]);
    let c = await t.run(async (ctx: any) => ctx.db.get(conv));
    expect([String(c.priority_id), c.priority_step_key, c.priority_set_by]).toEqual([String(p1), "s1", "person"]);
    await dispatch(t, ada, "movePrioritySession", ["jx7own1", "pri-1", "pri-1", null]);
    c = await t.run(async (ctx: any) => ctx.db.get(conv));
    expect([String(c.priority_id), c.priority_step_key ?? null]).toEqual([String(p1), null]);
    await dispatch(t, ada, "prioritySessionNotThis", ["jx7own1", "pri-1"]);
    c = await t.run(async (ctx: any) => ctx.db.get(conv));
    expect([c.priority_id ?? null, (c.priority_not ?? []).map(String)]).toEqual([null, [String(p1)]]);
    await dispatch(t, ada, "correctPriority", ["pri-1", "Calibration belongs here", "s1"]);
    const [row] = await t.run(async (ctx: any) => ctx.db.query("priority_corrections").collect());
    expect([row.text, row.step_key, row.status]).toEqual(["Calibration belongs here", "s1", "pending"]);
    await dispatch(t, ada, "deletePriorityCorrection", [String(row._id)]);
    expect(await t.run(async (ctx: any) => ctx.db.query("priority_corrections").collect())).toEqual([]);
    await t.run(async (ctx: any) => { for (const j of await ctx.db.system.query("_scheduled_functions").collect()) await ctx.scheduler.cancel(j._id); });
  });

  test("Run now schedules one pass for the presser in the workspace", async () => {
    const { t, ada, acme } = await world();
    await dispatch(t, ada, "runPriorities", [`team:${acme}`]);
    const jobs = await t.run(async (ctx: any) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("priorityPassRun")));
    expect(jobs.map((j: any) => [j.name, j.args[0]])).toEqual([["priorityPassRun:runNow", { user_id: ada, workspace: `team:${acme}` }]]);
    await t.run(async (ctx: any) => { for (const j of jobs) await ctx.scheduler.cancel(j._id); });
  });

  test("a teammate's press is refused and changes nothing", async () => {
    const { t, bea, p2 } = await world();
    await expect(dispatch(t, bea, "movePriority", ["pri-2", 1])).rejects.toThrow(/only they can change it/);
    const two = await t.run(async (ctx: any) => ctx.db.get(p2));
    expect([two.person_pos, two.ai_rank]).toEqual([undefined, 2]);
  });
});
