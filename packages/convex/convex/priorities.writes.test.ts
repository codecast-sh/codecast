// Priorities API writes (priorities.ts, priorityWrite.ts): the owner's
// controls (a move, step tier, set aside, merge, corrections) that the pass
// must never override. The reads are priorities.test.ts.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { PRIORITY_PASS_DAILY_USD } from "./priorityPassRun";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);

const pri = (api as any).priorities;
const TOKEN = "cc_test_priorities_ada";
const CY_TOKEN = "cc_test_priorities_cy";
const DAY = 86_400_000;
const NOW = Date.now();

/** A list answer's rows. */
const rowsOf = async (asUser: any, args: Record<string, unknown>) => (await asUser.query(pri.list, args)).priorities;

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
      user_id: ada, workspace: ws, short_id, title: `Priority ${short_id}`, summary: "", status: "active",
      steps: [], first_seen_at: NOW - 10 * DAY, last_active_at: NOW - DAY, pass_at: NOW, created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    const p1 = await insertPriority("pri-1", { ai_rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
    const p2 = await insertPriority("pri-2", { ai_rank: 2 });
    const p3 = await insertPriority("pri-3", { last_active_at: NOW - 2 * DAY });
    const p4 = await insertPriority("pri-4", { status: "done", done_at: NOW - DAY });
    const personal = await insertPriority("pri-5", { workspace: `user:${ada}`, ai_rank: 1 });
    const dark = await insertPriority("pri-6", { workspace: `team:${off}`, ai_rank: 1 });

    const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
      user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
      started_at: NOW, updated_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active", ...fields,
    } as any);
    const c1 = await conv("jx7one1", { priority_id: p1, priority_step_key: "s2" });
    const c2 = await conv("jx7two2", {});
    const c3 = await conv("jx7pvt3", { priority_id: p1, priority_step_key: "s1", is_private: true, team_visibility: "private" });
    const c4 = await conv("jx7per4", { priority_id: personal });
    // A teammate reads a priority only through a session of it listed to the team: one each for pri-2..4.
    for (const [short_id, priority_id] of [["jx7two5", p2], ["jx7thr6", p3], ["jx7fou7", p4]] as const) await conv(short_id, { priority_id, updated_at: NOW - 2 * DAY });

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

describe("writes", () => {
  /** What each row stores of its rank: [short id, person_pos, ai_rank]. */
  const places = (t: any, ids: Id<"priorities">[]) => t.run(async (ctx: any) => Promise.all(ids.map(async (id) => {
    const p = await ctx.db.get(id);
    return [p.short_id, p.person_pos ?? null, p.ai_rank ?? null];
  })));

  const positions = async (as: any) => (await rowsOf(as, { status: "active" })).filter((r: any) => r.workspace.startsWith("team:")).map((r: any) => `${r.rank}:${r.short_id}`);

  test("a move places one priority between its neighbours and moves nothing else; the list and the pin line show the effective positions", async () => {
    const { t, as, ada, acme, p1, p2, p3, c1 } = await world();
    expect(await as(ada).mutation(pri.moveTo, { short_id: "pri-3", to: 1 })).toMatchObject({ short_id: "pri-3", rank: 1, rank_source: "person", person_pos: 0 });
    expect(await places(t, [p1, p2, p3])).toEqual([["pri-1", null, 1], ["pri-2", null, 2], ["pri-3", 0, null]]);
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-1", "3:pri-2"]);
    expect((await rowsOf(as(ada), { workspace: `team:${acme}`, status: "active" })).map((r: any) => r.rank_source)).toEqual(["person", "ai", "ai"]);
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1", rank: 2 });
    // Past the end is the last position.
    expect(await t.mutation(pri.cliMove, { api_token: TOKEN, short_id: "pri-1", to: 99 })).toMatchObject({ short_id: "pri-1", rank: 3, person_pos: 3 });
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-2", "3:pri-1"]);
    expect(await t.mutation(pri.cliMove, { api_token: TOKEN, short_id: "pri-4", to: 1 })).toEqual({ error: expect.stringContaining("only active priorities are ranked") });
    expect(await t.mutation(pri.cliMove, { api_token: TOKEN, short_id: "pri-2", to: 1.5 })).toEqual({ error: "a rank is a whole number from 1" });
  });

  test("in a group of 250, the list, the page, the pin line and a move read one order", async () => {
    const { t, as, ada, ws, c1 } = await world();
    // pri-1..pri-4 leave; 250 active ones, the pass's #1 the least recently active, so outside the newest 200.
    const ids = await t.run(async (ctx) => {
      for (const p of await ctx.db.query("priorities").collect()) await ctx.db.patch(p._id, { status: "quiet" } as any);
      const out: Id<"priorities">[] = [];
      for (let i = 0; i < 250; i++) {
        out.push(await ctx.db.insert("priorities", {
          user_id: ada, workspace: ws, short_id: `pri-${100 + i}`, title: `P${i}`, summary: "", status: "active", ai_rank: i + 1, steps: [],
          first_seen_at: 1, last_active_at: NOW - (250 - i) * 60_000, pass_at: 1, created_at: 1, updated_at: 1,
        } as any));
      }
      await ctx.db.patch(c1, { priority_id: out[249], priority_step_key: undefined } as any);
      return out;
    });
    const listed = (await rowsOf(as(ada), { workspace: ws, status: "active" })) as any[];
    const last = listed.find((r) => r.short_id === "pri-349")!;
    expect(last.rank).toBe(250);
    expect((await as(ada).query(pri.show, { short_id: "pri-349" })).rank).toBe(250);
    expect((await as(ada).query(pri.pinLine, { conversation_id: c1 })).rank).toBe(250);
    // The pass's #1 is not listed (the newest 200 are), and still ranks first on its page.
    expect(listed.some((r) => r.short_id === "pri-100")).toBe(false);
    expect((await as(ada).query(pri.show, { short_id: "pri-100" })).rank).toBe(1);
    await as(ada).mutation(pri.moveTo, { short_id: "pri-349", to: 1 });
    expect((await as(ada).query(pri.show, { short_id: "pri-349" })).rank).toBe(1);
    expect((await as(ada).query(pri.show, { short_id: "pri-100" })).rank).toBe(2);
    void ids;
  });

  test("a merge, the person's or the pass's, moves every correction of the absorbed priority, however many", async () => {
    const { t, as, ada, ws, p1, p2, p3 } = await world();
    const correct = (priority_id: Id<"priorities">, n: number) => t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("priority_corrections", {
          user_id: ada, workspace: ws, priority_id, text: `fix ${i}`, status: "pending", created_at: NOW + i,
          snapshot: { short_id: "x", title: "x", summary: "", status: "active", steps: [] },
        } as any);
      }
    });
    const on = (id: Id<"priorities">) => t.run(async (ctx) => (await ctx.db.query("priority_corrections").withIndex("by_priority_created", (q) => q.eq("priority_id", id)).collect()).length);
    await correct(p2, 120);
    await as(ada).mutation(pri.merge, { short_id: "pri-2", into: "pri-1" });
    expect([await on(p2), await on(p1)]).toEqual([0, 120]);
    await correct(p3, 250);
    await t.mutation((internal as any).priorityPassRun.applyPlan, {
      user_id: ada, workspace: ws, started_at: Date.now(), from_cursor: 1, cursor_at: 2, model: "m",
      plan: { creates: [], updates: [], merges: [{ short_id: "pri-3", merged_into: "pri-1" }], sessions: [], unmap: [], notes: [], rewritten: [] },
    });
    expect([await on(p3), await on(p1)]).toEqual([0, 370]);
  });

  test("move up and move down step one place, renumbering only when a neighbour has no place; at the top it stays first", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.moveUp, { short_id: "pri-2" });
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-1", "3:pri-3"]);
    expect(await places(t, [p1, p2, p3])).toEqual([["pri-1", null, 1], ["pri-2", 0, 2], ["pri-3", null, null]]);
    // Below pri-1 sits pri-3, which neither the person nor the pass placed: every place is renumbered in order.
    await as(ada).mutation(pri.moveDown, { short_id: "pri-2" });
    expect(await positions(as(ada))).toEqual(["1:pri-1", "2:pri-2", "3:pri-3"]);
    expect(await places(t, [p1, p2, p3])).toEqual([["pri-1", null, 1], ["pri-2", 2, 2], ["pri-3", null, 3]]);
    await as(ada).mutation(pri.moveUp, { short_id: "pri-1" });
    expect(await positions(as(ada))).toEqual(["1:pri-1", "2:pri-2", "3:pri-3"]);
  });

  test("a step's tier is the person's once set", async () => {
    const { t, as, ada, p1 } = await world();
    await as(ada).mutation(pri.setStepTier, { short_id: "pri-1", step_key: "s2", tier: "polish" });
    const steps = await t.run(async (ctx) => (await ctx.db.get(p1))!.steps);
    expect(steps.find((s) => s.key === "s2")).toMatchObject({ tier: "polish", tier_set_by: "person" });
    expect(steps.find((s) => s.key === "s1")).toMatchObject({ tier: "critical", tier_set_by: "pass" });
    expect(await t.mutation(pri.cliSetStepTier, { api_token: TOKEN, short_id: "pri-1", step_key: "s9", tier: "critical" })).toEqual({ error: "pri-1 has no milestone s9; its milestones: s1, s2, s3" });
  });

  test("set aside leaves the ranking; restore brings it back as the pass's, after every ranked one", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.moveTo, { short_id: "pri-1", to: 1 });
    await as(ada).mutation(pri.setAside, { short_id: "pri-1" });
    expect(await places(t, [p1, p2, p3])).toEqual([["pri-1", null, null], ["pri-2", null, 2], ["pri-3", null, null]]);
    expect((await t.run(async (ctx) => ctx.db.get(p1)))!.status).toBe("set_aside");
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-3"]);
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-1" })).toMatchObject({ short_id: "pri-1", status: "active", rank: 2, rank_source: "ai", ai_rank: 3 });
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-1", "3:pri-3"]);
    await expect(as(ada).mutation(pri.restore, { short_id: "pri-1" })).rejects.toThrow("pri-1 is active; only a set-aside or done priority is restored");
    // Reopening one the pass marked done is the person's call: the pass keeps it open.
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-4" })).toMatchObject({ short_id: "pri-4", status: "active", status_set_by: "person", done_at: null });
  });

  test("a quiet priority the person placed comes back to its place after other moves and a restore", async () => {
    const { t, as, ada, ws, p1, p2, p3 } = await world();
    // A, Q (quiet), B, C as the person placed them; R (done) restored last.
    await t.run(async (ctx) => {
      await ctx.db.patch(p1, { person_pos: 1, ai_rank: undefined });
      await ctx.db.patch(p2, { person_pos: 1.5, ai_rank: undefined, status: "quiet" });
      await ctx.db.patch(p3, { person_pos: 2 });
      await ctx.db.insert("priorities", {
        user_id: ada, workspace: ws, short_id: "pri-8", title: "C", summary: "", status: "active", person_pos: 3,
        steps: [], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      } as any);
    });
    await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-4" });
    await as(ada).mutation(pri.moveTo, { short_id: "pri-8", to: 1 });
    await as(ada).mutation(pri.moveTo, { short_id: "pri-3", to: 4 });
    expect(await positions(as(ada))).toEqual(["1:pri-8", "2:pri-1", "3:pri-4", "4:pri-3"]);
    await t.run(async (ctx) => ctx.db.patch(p2, { status: "active" }));
    expect(await positions(as(ada))).toEqual(["1:pri-8", "2:pri-1", "3:pri-2", "4:pri-4", "5:pri-3"]);
  });

  test("only the owner changes a priority", async () => {
    const { t, as, bea, p1 } = await world();
    await expect(as(bea).mutation(pri.moveTo, { short_id: "pri-1", to: 2 })).rejects.toThrow("pri-1 is Ada's priority; only they can change it");
    await expect(as(bea).mutation(pri.setAside, { short_id: "pri-1" })).rejects.toThrow("only they can change it");
    expect((await t.run(async (ctx) => ctx.db.get(p1)))!).toMatchObject({ status: "active", ai_rank: 1 });
  });

  test("with the feature off, writes and runs are refused", async () => {
    const { t, as, ada, off } = await world();
    const offMessage = teamFeatureOffMessage("priorities");
    await expect(as(ada).mutation(pri.moveTo, { short_id: "pri-6", to: 1 })).rejects.toThrow(offMessage);
    expect(await t.mutation(pri.cliSetAside, { api_token: TOKEN, short_id: "pri-6" })).toEqual({ error: offMessage });
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: off })).toEqual({ error: offMessage });
  });

  test("run refuses a team the caller is not in, and schedules nothing", async () => {
    const { t, acme } = await world();
    expect(await t.mutation(pri.cliRun, { api_token: CY_TOKEN, team_id: acme })).toEqual({ error: "you are not a member of that team" });
    expect(await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test("run says why runNow would refuse, and schedules nothing", async () => {
    const { t, ada, acme, ws } = await world();
    await t.run(async (ctx) => ctx.db.insert("priority_pass_runs", {
      user_id: ada, workspace: ws, started_at: Date.now() - 90_000, finished_at: Date.now(), status: "ok", cursor_at: 0, model: "m", cost_usd: 0.1,
      counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 },
    }));
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme })).toEqual({ error: "A pass ran here 2 minutes ago; run it again in 9 minutes." });
    await t.run(async (ctx) => ctx.db.insert("priority_pass_runs", {
      user_id: ada, workspace: ws, started_at: Date.now() - 60 * 60_000, finished_at: Date.now(), status: "ok", cursor_at: 0, model: "m", cost_usd: PRIORITY_PASS_DAILY_USD + 0.5,
      counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 },
    }));
    await t.run(async (ctx) => { for (const r of await ctx.db.query("priority_pass_runs").collect()) if (r.cost_usd === 0.1) await ctx.db.delete(r._id); });
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme })).toEqual({ error: `Passes here spent today's $${PRIORITY_PASS_DAILY_USD.toFixed(2)}; the next one can run tomorrow.` });
    expect(await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual([]);
  });

  test("run schedules one pass for the caller in the workspace", async () => {
    const { t, ada, acme, ws } = await world();
    const res = await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme });
    expect(res.scheduled).toEqual([ws]);
    // Ada has no pass yet: the note says the first catch-up reads oldest work first, over a few minutes.
    expect(res.note).toContain("results land in a few minutes");
    expect(res.note).toContain("oldest work first");
    const jobs = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const run = jobs.filter((j: any) => j.name.includes("priorityPassRun"));
    expect(run.map((j: any) => [j.name, j.args[0]])).toEqual([["priorityPassRun:runNow", { user_id: ada, workspace: ws }]]);
    // The pass itself is priorityPassRun's to test; never let it reach a model from here.
    await t.run(async (ctx) => { for (const j of run) await ctx.scheduler.cancel(j._id); });
  });
});
