// Priorities API (priorities.ts): who reads a priority, what history counts,
// the pin line, and the owner's controls (rank, step tier, set aside) that the
// pass must never override.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);

const pri = (api as any).priorities;
const TOKEN = "cc_test_priorities_ada";
const CY_TOKEN = "cc_test_priorities_cy";
const DAY = 86_400_000;
const NOW = Date.now();

const step = (key: string, tier: "critical" | "polish", done = false) => ({ key, title: `Step ${key}`, tier, tier_set_by: "pass" as const, refs: [], done });

/**
 * Ada and Bea share team Acme (priorities on); Cy is in team Other. Ada is
 * also in team Off, where the feature is off. Ada owns every priority.
 */
async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const cy = await ctx.db.insert("users", { name: "Cy" } as any);
    const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: NOW, features: { priorities: true } } as any);
    const off = await ctx.db.insert("teams", { name: "Off", created_at: NOW } as any);
    for (const [u, team] of [[ada, acme], [bea, acme], [cy, other], [ada, off]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    }
    for (const [u, token] of [[ada, TOKEN], [cy, CY_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(token), name: "cli", created_at: NOW, last_used_at: NOW } as any);
    }

    const ws = `team:${acme}`;
    const insertPriority = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("priorities", {
      user_id: ada, workspace: ws, short_id, title: `Priority ${short_id}`, summary: "", status: "active", rank_set_by: "pass",
      steps: [], first_seen_at: NOW - 10 * DAY, last_active_at: NOW - DAY, pass_at: NOW, created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    const p1 = await insertPriority("pri-1", { rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
    const p2 = await insertPriority("pri-2", { rank: 2 });
    const p3 = await insertPriority("pri-3", { last_active_at: NOW - 2 * DAY });
    const p4 = await insertPriority("pri-4", { status: "done", done_at: NOW - DAY });
    const personal = await insertPriority("pri-5", { workspace: `user:${ada}`, rank: 1 });
    const dark = await insertPriority("pri-6", { workspace: `team:${off}`, rank: 1 });

    const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
      user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
      started_at: NOW, updated_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active", ...fields,
    } as any);
    const c1 = await conv("jx7one1", { priority_id: p1, priority_step_key: "s2" });
    const c2 = await conv("jx7two2", {});
    const c3 = await conv("jx7pvt3", { priority_id: p1, priority_step_key: "s1", is_private: true, team_visibility: "private" });
    const c4 = await conv("jx7per4", { priority_id: personal });

    const send = async (user: Id<"users">, c: Id<"conversations">, timestamp: number, extra: Record<string, unknown> = {}) => {
      const message = await ctx.db.insert("messages", { conversation_id: c, role: "user", content: "x", timestamp } as any);
      await ctx.db.insert("user_sends", { user_id: user, team_id: acme, conversation_id: c, message_id: message, timestamp, words: 1, text: "x", clipped: false, ...extra } as any);
    };
    await send(ada, c1, NOW - 60_000);
    await send(ada, c1, NOW - DAY);
    await send(ada, c2, NOW - 60_000);
    await send(ada, c1, NOW - 60_000, { decision: { question: "q", picked: true } });
    for (let i = 0; i < 3; i++) await send(bea, c1, NOW - 60_000);
    return { ada, bea, cy, acme, off, ws, p1, p2, p3, p4, personal, dark, c1, c2, c3, c4 };
  });
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|session` });
  return { t, as, ...ids };
}

describe("reads", () => {
  test("the owner and a teammate holding the workspace key see a priority; someone outside it does not", async () => {
    const { as, ada, bea, cy, ws } = await world();
    const mine = await as(ada).query(pri.list, { workspace: ws });
    expect(mine.map((r: any) => r.short_id)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4"]);
    expect(mine[0]).toMatchObject({ counts: { critical_done: 1, critical_total: 2 }, mine: true, owner: "Ada" });
    expect(mine[0].sessions.map((s: any) => s.short_id).sort()).toEqual(["jx7one1", "jx7pvt3"]);

    const teammate = await as(bea).query(pri.list, { workspace: ws });
    expect(teammate.map((r: any) => r.short_id)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4"]);
    expect(teammate[0].mine).toBe(false);
    // A private session stays its owner's, even when it serves a priority the teammate can read.
    expect(teammate[0].sessions.map((s: any) => s.short_id)).toEqual(["jx7one1"]);
    expect(await as(bea).query(pri.list, {})).toHaveLength(4);

    expect(await as(cy).query(pri.list, {})).toEqual([]);
    expect(await as(cy).query(pri.list, { workspace: ws })).toEqual([]);
    expect(await as(cy).query(pri.show, { short_id: "pri-1" })).toBeNull();
    expect(await as(bea).query(pri.show, { short_id: "pri-5" })).toBeNull();
  });

  test("a list counts a priority's sessions and shows the three most recently active; old finished ones only with all or a status", async () => {
    const { t, as, ada, ws, p1, acme } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("conversations", {
          user_id: ada, team_id: acme, agent_type: "claude_code", session_id: `more${i}`, short_id: `jx7mor${i}`, title: "more",
          started_at: NOW, updated_at: NOW - (i + 1) * DAY, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p1,
        } as any);
      }
      await ctx.db.insert("priorities", {
        user_id: ada, workspace: ws, short_id: "pri-7", title: "Long done", summary: "", status: "done", rank_set_by: "pass", steps: [],
        first_seen_at: NOW - 200 * DAY, last_active_at: NOW - 90 * DAY, done_at: NOW - 90 * DAY, pass_at: NOW, created_at: NOW, updated_at: NOW,
      } as any);
    });
    const [first] = await as(ada).query(pri.list, { workspace: ws });
    expect(first.session_count).toBe(6);
    expect(first.sessions.map((s: any) => s.short_id)).toEqual(["jx7one1", "jx7pvt3", "jx7mor0"]);
    expect((await as(ada).query(pri.show, { short_id: "pri-1" })).other_sessions).toHaveLength(4);
    const ids = async (args: any) => (await as(ada).query(pri.list, { workspace: ws, ...args })).map((r: any) => r.short_id);
    expect(await ids({})).not.toContain("pri-7");
    expect(await ids({ all: true })).toContain("pri-7");
    expect(await ids({ status: "done" })).toEqual(["pri-4", "pri-7"]);
  });

  test("show groups the mapped sessions under their steps", async () => {
    const { as, ada } = await world();
    const p = await as(ada).query(pri.show, { short_id: "PRI-1" });
    expect(p.steps.map((s: any) => [s.key, s.sessions.map((c: any) => c.short_id)])).toEqual([["s1", ["jx7pvt3"]], ["s2", ["jx7one1"]], ["s3", []]]);
    expect(p.other_sessions).toEqual([]);
  });

  test("history counts only the viewer's own typing, per priority and unassigned, never an option pick", async () => {
    const { as, ada, bea, ws } = await world();
    const res = await as(ada).query(pri.history, { days: 15, workspace: ws });
    expect(res.days).toHaveLength(15);
    const lanes = Object.fromEntries(res.lanes.map((l: any) => [l.key, l]));
    expect(lanes["pri-1"].total).toBe(2);
    expect(lanes["pri-1"].counts.at(-1) + lanes["pri-1"].counts.at(-2)).toBe(2);
    expect(lanes.unassigned.total).toBe(1);
    expect(res.lanes.map((l: any) => l.key)).toEqual(["pri-1", "unassigned"]);

    const theirs = await as(bea).query(pri.history, { days: 15 });
    expect(theirs.lanes.map((l: any) => [l.key, l.total])).toEqual([["pri-1", 3]]);
  });

  test("the pin line names the priority, its critical path and the session's step; null where the viewer cannot see the priority", async () => {
    const { as, ada, bea, cy, c1, c2, c4 } = await world();
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toEqual({
      short_id: "pri-1", title: "Priority pri-1", rank: 1, critical_done: 1, critical_total: 2, step_title: "Step s2",
    });
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1" });
    expect(await as(ada).query(pri.pinLine, { conversation_id: c2 })).toBeNull();
    // Bea can open the session, but its priority lives in Ada's personal workspace.
    expect(await as(ada).query(pri.pinLine, { conversation_id: c4 })).toMatchObject({ short_id: "pri-5" });
    expect(await as(bea).query(pri.pinLine, { conversation_id: c4 })).toBeNull();
    expect(await as(cy).query(pri.pinLine, { conversation_id: c1 })).toBeNull();
  });

  test("with the feature off for a workspace, nothing there reads", async () => {
    const { t, as, ada, off, dark, c1 } = await world();
    expect(await as(ada).query(pri.list, { workspace: `team:${off}` })).toEqual([]);
    expect((await as(ada).query(pri.list, {})).map((r: any) => r.short_id)).not.toContain("pri-6");
    expect(await as(ada).query(pri.show, { short_id: "pri-6" })).toBeNull();
    expect(await t.query(pri.cliShow, { api_token: TOKEN, short_id: "pri-6" })).toEqual({ error: teamFeatureOffMessage("priorities") });
    await t.run(async (ctx) => ctx.db.patch(c1, { priority_id: dark }));
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toBeNull();
    expect((await as(ada).query(pri.history, {})).lanes.map((l: any) => l.key)).toEqual(["unassigned"]);
  });
});

describe("writes", () => {
  const ranks = (t: any, ids: Id<"priorities">[]) => t.run(async (ctx: any) => Promise.all(ids.map(async (id) => {
    const p = await ctx.db.get(id);
    return [p.short_id, p.rank ?? null, p.rank_set_by];
  })));

  const positions = async (as: any) => (await as.query(pri.list, { status: "active" })).filter((r: any) => r.workspace.startsWith("team:")).map((r: any) => `${r.rank}:${r.short_id}`);

  test("rank pins one priority to a slot and moves nothing else; the list and the pin line show the effective positions", async () => {
    const { t, as, ada, p1, p2, p3, c1 } = await world();
    expect(await as(ada).mutation(pri.rank, { short_id: "pri-3", rank: 1 })).toMatchObject({ short_id: "pri-3", rank: 1, rank_set_by: "person" });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 1, "pass"], ["pri-2", 2, "pass"], ["pri-3", 1, "person"]]);
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-1", "3:pri-2"]);
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1", rank: 2 });
    // A slot past the end shows as the last position.
    expect(await t.mutation(pri.cliRank, { api_token: TOKEN, short_id: "pri-1", rank: 99 })).toMatchObject({ short_id: "pri-1", rank: 3 });
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-2", "3:pri-1"]);
    expect(await t.mutation(pri.cliRank, { api_token: TOKEN, short_id: "pri-4", rank: 1 })).toEqual({ error: expect.stringContaining("only active priorities are ranked") });
  });

  test("a person's slot taken by a later drag pushes the earlier one down, and a pass's write changes neither", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.rank, { short_id: "pri-1", rank: 2 });
    await as(ada).mutation(pri.rank, { short_id: "pri-3", rank: 2 });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 3, "person"], ["pri-2", 2, "pass"], ["pri-3", 2, "person"]]);
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-3", "3:pri-1"]);
    // A pass touches the pushed one last; the slots hold.
    await t.run(async (ctx) => ctx.db.patch(p1, { updated_at: Date.now() + 60_000, summary: "pass wrote" }));
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-3", "3:pri-1"]);
    // A chain: pri-2 to #2 pushes pri-3 to 3, which pushes pri-1 to 4.
    await as(ada).mutation(pri.rank, { short_id: "pri-2", rank: 2 });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 4, "person"], ["pri-2", 2, "person"], ["pri-3", 3, "person"]]);
  });

  test("a step's tier is the person's once set", async () => {
    const { t, as, ada, p1 } = await world();
    await as(ada).mutation(pri.setStepTier, { short_id: "pri-1", step_key: "s2", tier: "polish" });
    const steps = await t.run(async (ctx) => (await ctx.db.get(p1))!.steps);
    expect(steps.find((s) => s.key === "s2")).toMatchObject({ tier: "polish", tier_set_by: "person" });
    expect(steps.find((s) => s.key === "s1")).toMatchObject({ tier: "critical", tier_set_by: "pass" });
    expect(await t.mutation(pri.cliSetStepTier, { api_token: TOKEN, short_id: "pri-1", step_key: "s9", tier: "critical" })).toEqual({ error: "pri-1 has no step s9; its steps: s1, s2, s3" });
  });

  test("set aside leaves the ranking; restore brings it back after the pass-ranked ones", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.setAside, { short_id: "pri-1" });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", null, "pass"], ["pri-2", 2, "pass"], ["pri-3", null, "pass"]]);
    expect((await t.run(async (ctx) => ctx.db.get(p1)))!.status).toBe("set_aside");
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-3"]);
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-1" })).toMatchObject({ short_id: "pri-1", status: "active", rank: 2 });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 3, "pass"], ["pri-2", 2, "pass"], ["pri-3", null, "pass"]]);
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-1", "3:pri-3"]);
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-4" })).toEqual({ error: "pri-4 is done, not set aside; only a set-aside priority is restored" });
    await expect(as(ada).mutation(pri.restore, { short_id: "pri-1" })).rejects.toThrow("only a set-aside priority is restored");
  });

  test("only the owner changes a priority", async () => {
    const { t, as, bea, p1 } = await world();
    await expect(as(bea).mutation(pri.rank, { short_id: "pri-1", rank: 2 })).rejects.toThrow("pri-1 is Ada's priority; only they can change it");
    await expect(as(bea).mutation(pri.setAside, { short_id: "pri-1" })).rejects.toThrow("only they can change it");
    expect((await t.run(async (ctx) => ctx.db.get(p1)))!).toMatchObject({ status: "active", rank: 1 });
  });

  test("with the feature off, writes and runs are refused", async () => {
    const { t, as, ada, off } = await world();
    const offMessage = teamFeatureOffMessage("priorities");
    await expect(as(ada).mutation(pri.rank, { short_id: "pri-6", rank: 1 })).rejects.toThrow(offMessage);
    expect(await t.mutation(pri.cliSetAside, { api_token: TOKEN, short_id: "pri-6" })).toEqual({ error: offMessage });
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: off })).toEqual({ error: offMessage });
  });

  test("run refuses a team the caller is not in, and schedules nothing", async () => {
    const { t, acme } = await world();
    expect(await t.mutation(pri.cliRun, { api_token: CY_TOKEN, team_id: acme })).toEqual({ error: "you are not a member of that team" });
    expect(await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test("run schedules one pass for the caller in the workspace", async () => {
    const { t, ada, acme, ws } = await world();
    const res = await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme });
    expect(res.scheduled).toEqual([ws]);
    const jobs = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const run = jobs.filter((j: any) => j.name.includes("priorityPassRun"));
    expect(run.map((j: any) => [j.name, j.args[0]])).toEqual([["priorityPassRun:runNow", { user_id: ada, workspace: ws }]]);
    // The pass itself is priorityPassRun's to test; never let it reach a model from here.
    await t.run(async (ctx) => { for (const j of run) await ctx.scheduler.cancel(j._id); });
  });
});
