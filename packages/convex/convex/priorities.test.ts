// Priorities API (priorities.ts): who reads a priority, what history counts,
// the pin line, and the owner's controls (rank, step tier, set aside) that the
// pass must never override.
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { HISTORY_SENDS_CAP, TEAMMATE_PRIORITIES_CAP } from "./priorities";
import { nextSweepAt } from "./priorityPassSweep";
import { sessionListedToTeam, sessionSharedWithTeam } from "./lib/prioritySessionVisibility";
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

describe("reads", () => {
  test("the owner and a teammate holding the workspace key see a priority; someone outside it does not", async () => {
    const { as, ada, bea, cy, ws } = await world();
    const mine = await rowsOf(as(ada), { workspace: ws });
    expect(mine.map((r: any) => r.short_id)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4"]);
    expect(mine[0]).toMatchObject({ counts: { critical_done: 1, critical_total: 2 }, mine: true, owner: "Ada" });
    expect(mine[0].sessions.map((s: any) => s.short_id).sort()).toEqual(["jx7one1", "jx7pvt3"]);

    const teammate = await rowsOf(as(bea), { workspace: ws });
    expect(teammate.map((r: any) => r.short_id)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4"]);
    expect(teammate[0].mine).toBe(false);
    // A private session stays its owner's, even when it serves a priority the teammate can read.
    expect(teammate[0].sessions.map((s: any) => s.short_id)).toEqual(["jx7one1"]);
    expect(await rowsOf(as(bea), {})).toHaveLength(4);

    expect(await rowsOf(as(cy), {})).toEqual([]);
    expect(await rowsOf(as(cy), { workspace: ws })).toEqual([]);
    expect(await as(cy).query(pri.show, { short_id: "pri-1" })).toBeNull();
    expect(await as(bea).query(pri.show, { short_id: "pri-5" })).toBeNull();
  });

  test("a list counts up to 50 of a priority's sessions and shows the three newest; old finished ones only with all or a status", async () => {
    const { t, as, ada, bea, ws, p1, acme } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
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
    // 52 mapped: a list reads the newest 51, counts 50 of them and says there are more.
    const [first] = await rowsOf(as(ada), { workspace: ws });
    expect(first).toMatchObject({ session_count: 50, session_count_more: true });
    expect(first.sessions.map((s: any) => s.short_id)).toEqual(["jx7mor49", "jx7mor48", "jx7mor47"]);
    const shown = await as(ada).query(pri.show, { short_id: "pri-1" });
    // show reads every session but counts as the list does, so the two agree.
    expect(shown).toMatchObject({ session_count: 50, session_count_more: true });
    // A teammate counts among the newest four only: "4+", in the list and in show.
    const theirs = (await rowsOf(as(bea), { workspace: ws })).find((r: any) => r.short_id === "pri-1");
    expect(theirs).toMatchObject({ session_count: 4, session_count_more: true });
    expect(await as(bea).query(pri.show, { short_id: "pri-1" })).toMatchObject({ session_count: 4, session_count_more: true });
    expect(shown.other_sessions).toHaveLength(50);
    const ids = async (args: any) => (await rowsOf(as(ada), { workspace: ws, ...args })).map((r: any) => r.short_id);
    expect(await ids({})).not.toContain("pri-7");
    expect(await ids({ all: true })).toContain("pri-7");
    expect(await ids({ status: "done" })).toEqual(["pri-4", "pri-7"]);
  });

  test("the owner reads the pass's stored session count; a teammate, the sessions they can open; list and show agree", async () => {
    const { t, as, ada, bea, ws, p1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(p1, { session_count: 120 }));
    const counts = async (who: Id<"users">) => {
      const [row] = await rowsOf(as(who), { workspace: ws });
      const shown = await as(who).query(pri.show, { short_id: "pri-1" });
      return [row.session_count, shown.session_count, row.sessions.map((s: any) => s.short_id)];
    };
    expect(await counts(ada)).toEqual([120, 120, ["jx7pvt3", "jx7one1"]]);
    // Bea cannot open Ada's private session: she counts the one she can.
    expect(await counts(bea)).toEqual([1, 1, ["jx7one1"]]);
  });

  test("a list says how far the viewer's pass lags and when the next one runs", async () => {
    const { t, as, ada, ws } = await world();
    const meta = async () => {
      const { behind_by_ms, next_pass_at } = await as(ada).query(pri.list, { workspace: ws });
      return { behind_by_ms, next_pass_at };
    };
    const before = await meta();
    expect(before.behind_by_ms).toBeNull();
    expect(before.next_pass_at).toBe(nextSweepAt(Date.now()));
    await t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: ada, workspace: ws, started_at: NOW - 9 * 3_600_000, finished_at: NOW - 9 * 3_600_000, status: "ok", cursor_at: NOW - 8 * 3_600_000, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    expect(Math.floor((await meta()).behind_by_ms! / 3_600_000)).toBe(8);
    await t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: ada, workspace: ws, started_at: Date.now(), finished_at: Date.now(), status: "running", cursor_at: NOW - 8 * 3_600_000, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    expect((await meta()).next_pass_at!).toBeLessThanOrEqual(Date.now());
  });

  test("turning the feature on starts that team's sweep at once", async () => {
    const { t, off } = await world();
    await t.mutation((internal as any).teamFeatures.setTeamFeatureInternal, { team_id: off, feature: "priorities", enabled: true });
    const jobs = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j: any) => j.name.includes("priorityPass")));
    expect(jobs.map((j: any) => [j.name, j.args[0]])).toEqual([["priorityPassSweep:sweepTeam", { team_id: off }]]);
    await t.run(async (ctx) => { for (const j of jobs) await ctx.scheduler.cancel(j._id); });
  });

  test("show groups the mapped sessions under their steps", async () => {
    const { as, ada } = await world();
    const p = await as(ada).query(pri.show, { short_id: "PRI-1" });
    expect(p.steps.map((s: any) => [s.key, s.sessions.map((c: any) => c.short_id)])).toEqual([["s1", ["jx7pvt3"]], ["s2", ["jx7one1"]], ["s3", []]]);
    expect(p.other_sessions).toEqual([]);
  });

  test("the viewer's own active row carries each step's sessions (state, mine, workflow, why), its plans, Looks done and pending corrections; nobody else's does", async () => {
    const { t, as, ada, bea, acme, ws, p1, c1 } = await world();
    await t.run(async (ctx) => {
      const plan = (short_id: string, size: number, status = "active") => ctx.db.insert("plans", {
        user_id: ada, team_id: acme, workspace: ws, short_id, title: `Plan ${short_id}`, status, source: "human", created_at: NOW, updated_at: NOW,
        task_ids: [], progress: { total: size, done: 2, in_progress: 0, open: size - 2 },
      } as any);
      const small = await plan("pl-1075", 37);
      const big = await plan("pl-619", 140);
      const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
        started_at: NOW, updated_at: NOW - 3_600_000, message_count: 3, is_private: false, team_visibility: "full", status: "active", ...fields,
      } as any);
      const blocked = { thread_state_status: "blocked", thread_state_at: NOW, last_turn_at: NOW - 1000 };
      const hidden = await conv("jx7hid1", { is_private: true, team_visibility: "private" });
      const asks = await conv("jx7ask1", blocked);
      const run = await conv("jx7run1", { title: "Review · ct-901 tidy", is_subagent: true, parent_conversation_id: c1, inbox_killed_at: NOW });
      await conv("jx7prk1", { thread_state_status: "dormant", thread_state_at: NOW, last_turn_at: NOW - 1000 });
      // Bea's session works Ada's task and asks Bea something: not Ada's to answer.
      const beas = await conv("jx7bea1", { ...blocked, user_id: bea });
      const task = (short_id: string, plan_id: Id<"plans"> | undefined, conversation_ids: Id<"conversations">[], status = "open") => ctx.db.insert("tasks", {
        user_id: ada, team_id: acme, workspace: ws, short_id, title: `Task ${short_id}`, status, plan_id, conversation_ids, created_at: NOW, updated_at: NOW,
      } as any);
      // A task's newest two sessions only: the private one is older.
      await task("ct-901", small, [hidden, asks, run]);
      await task("ct-902", small, [beas]);
      await task("ct-903", big, [], "done");
      const p = await ctx.db.get(p1);
      await ctx.db.patch(p1, { steps: [
        { ...p!.steps[0], refs: [{ kind: "task", id: "ct-901" }] },
        { ...p!.steps[1], refs: [{ kind: "task", id: "ct-902" }, { kind: "session", id: "jx7prk1" }] },
        { ...p!.steps[2], refs: [{ kind: "task", id: "ct-903" }] },
      ] } as any);
      await ctx.db.insert("priority_corrections", {
        user_id: ada, workspace: ws, priority_id: p1, step_key: "s2", text: "Session mapping is wrong", status: "pending", created_at: NOW,
        snapshot: { short_id: "pri-1", title: "Priority pri-1", summary: "", status: "active", steps: [] },
      } as any);
    });
    const [row] = await rowsOf(as(ada), { workspace: ws });
    const links = Object.fromEntries(row.links.map((l: any) => [l.key, l]));
    // s1: the session asking via its task first, the mapped one, the closed workflow run last.
    expect(links.s1.sessions.map((s: any) => [s.short_id, s.state, s.mine, s.workflow, s.why])).toEqual([
      ["jx7ask1", "needs_you", true, false, ["via ct-901"]],
      ["jx7pvt3", "idle", true, false, ["mapped"]],
      ["jx7run1", "killed", true, true, ["via ct-901"]],
    ]);
    // s2: Bea's blocked session reads idle and not Ada's.
    expect(links.s2.sessions.map((s: any) => [s.short_id, s.state, s.mine, s.why])).toEqual([
      ["jx7prk1", "dormant", true, ["linked"]],
      ["jx7one1", "idle", true, ["mapped"]],
      ["jx7bea1", "idle", false, ["via ct-902"]],
    ]);
    // Last activity to the 10 minutes, so a heartbeat leaves the answer as it was.
    for (const l of row.links) for (const s of l.sessions) expect(s.last_active_at % 600_000).toBe(0);
    // pl-1075 holds tasks from two of three task-bearing steps: the priority's plan; the 140-task pl-619 only "part of".
    expect(row.plan).toMatchObject({ short_id: "pl-1075", done: 2, total: 37 });
    expect(links.s1.plan).toBeNull();
    expect(links.s3.plan).toBeNull();
    expect(links.s3.part_of.map((p: any) => p.short_id)).toEqual(["pl-619"]);
    // s3 is open with its one task done; s1's task is open.
    expect([links.s1.looks_done, links.s3.looks_done]).toEqual([false, true]);
    expect([links.s1.correction_pending, links.s2.correction_pending]).toEqual([false, true]);
    expect(row.correction_pending).toBe(true);
    // A teammate's rows, and the viewer's past ones, carry no links.
    const [theirs] = await rowsOf(as(bea), { workspace: ws });
    expect(theirs.links).toBeUndefined();
    const past = (await rowsOf(as(ada), { workspace: ws })).find((r: any) => r.short_id === "pri-4");
    expect(past.links).toBeUndefined();
  });

  test("history names today's sessions no priority holds, for the No priority share", async () => {
    const { as, ada, ws } = await world();
    const res = await as(ada).query(pri.history, { days: 10, workspace: ws });
    expect(res.unassigned_today.map((s: any) => [s.short_id, s.title, s.count])).toEqual([["jx7two2", "Session jx7two2", 1]]);
  });

  test("history: the viewer's own priorities count their own typing, per priority and unassigned, never an option pick", async () => {
    const { as, ada, bea, ws } = await world();
    const res = await as(ada).query(pri.history, { days: 15, workspace: ws });
    expect(res.days).toHaveLength(15);
    const lanes = Object.fromEntries(res.lanes.map((l: any) => [l.key, l]));
    expect(lanes["pri-1"].total).toBe(2);
    expect(lanes["pri-1"].counts.at(-1) + lanes["pri-1"].counts.at(-2)).toBe(2);
    expect(lanes.unassigned.total).toBe(1);
    expect(res.lanes.map((l: any) => l.key)).toEqual(["pri-1", "unassigned"]);

    // Per session: the same counts, in sessions a lane holds (the unassigned session is not listed).
    const sum = (c: number[]) => c.reduce((a, b) => a + b, 0);
    expect(Object.keys(res.sessions)).toEqual(["jx7one1"]);
    expect(res.sessions.jx7one1).toHaveLength(15);
    expect(sum(res.sessions.jx7one1)).toBe(2);
    expect(res.lanes.some((l: any) => l.truncated)).toBe(false);
  });

  const membershipOf = (t: any, user: Id<"users">, team: Id<"teams">) =>
    t.run(async (ctx: any) => (await ctx.db.query("team_memberships").withIndex("by_user_id", (q: any) => q.eq("user_id", user)).collect()).find((m: any) => m.team_id === team)!._id);

  test("a teammate reads another's priorities only while the owner lists their sessions to the team", async () => {
    const { t, as, ada, bea, acme, c1 } = await world();
    const membership = await membershipOf(t, ada, acme);
    const seen = async () => ({
      list: (await rowsOf(as(bea), {})).map((r: any) => r.short_id),
      show: (await as(bea).query(pri.show, { short_id: "pri-1" }))?.short_id ?? null,
      pin: (await as(bea).query(pri.pinLine, { conversation_id: c1 }))?.short_id ?? null,
      history: (await as(bea).query(pri.history, {})).lanes.map((l: any) => l.key),
    });
    expect(await seen()).toEqual({ list: ["pri-1", "pri-2", "pri-3", "pri-4"], show: "pri-1", pin: "pri-1", history: ["pri-1"] });
    await t.run(async (ctx) => ctx.db.patch(membership, { visibility: "summary" }));
    expect((await seen()).show).toBe("pri-1");
    // Sharing only activity, or nothing, lists no session, so no priority either.
    for (const visibility of ["activity", "hidden"] as const) {
      await t.run(async (ctx) => ctx.db.patch(membership, { visibility }));
      expect(await seen()).toEqual({ list: [], show: null, pin: null, history: [] });
    }
    // The legacy account-wide setting hides them too.
    await t.run(async (ctx) => { await ctx.db.patch(membership, { visibility: "full" }); await ctx.db.patch(ada, { activity_visibility: "hidden" } as any); });
    expect(await seen()).toEqual({ list: [], show: null, pin: null, history: [] });
    // The owner always reads their own.
    expect((await rowsOf(as(ada), { workspace: `team:${acme}` })).map((r: any) => r.short_id)).toEqual(["pri-1", "pri-2", "pri-3", "pri-4"]);
  });

  test("history: a teammate's lane counts the owner's typing, each message only if they shared activity when they typed it", async () => {
    const { t, as, ada, bea, acme } = await world();
    // Bea typed 3 times in Ada's session; Ada's lane shows Ada's 2, never Bea's.
    const theirs = await as(bea).query(pri.history, { days: 15 });
    expect(theirs.lanes.map((l: any) => [l.key, l.total, l.owner])).toEqual([["pri-1", 2, "Ada"]]);
    expect(Object.keys(theirs.sessions)).toEqual(["jx7one1"]);
    // Ada was hidden until an hour ago: her message from a day ago is not counted.
    const membership = await membershipOf(t, ada, acme);
    await t.run(async (ctx) => ctx.db.patch(membership, { visibility: "full", visibility_history: [{ before: NOW - 3_600_000, visibility: "hidden" }] } as any));
    expect((await as(bea).query(pri.history, { days: 15 })).lanes.map((l: any) => [l.key, l.total])).toEqual([["pri-1", 1]]);
    // Ada's own view is unchanged.
    expect((await as(ada).query(pri.history, { days: 15 })).lanes.find((l: any) => l.key === "pri-1").total).toBe(2);
    // Every session of her priorities began while she was hidden: none is listed, so Bea sees no priority of hers.
    await t.run(async (ctx) => ctx.db.patch(membership, { visibility_history: [{ before: Date.now() + 60_000, visibility: "hidden" }] } as any));
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).toEqual([]);
    expect((await as(bea).query(pri.history, { days: 15 })).lanes).toEqual([]);
  });

  test("an auto-shared session locked private: a teammate no longer lists it, counts it, or reads the priority through it", async () => {
    const { t, as, bea, c1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(c1, { auto_shared: true }));
    const before = await rowsOf(as(bea), {});
    expect(before.find((r: any) => r.short_id === "pri-1").sessions.map((s: any) => s.short_id)).toEqual(["jx7one1"]);
    expect((await as(bea).query(pri.history, { days: 15 })).lanes.map((l: any) => [l.key, l.total])).toEqual([["pri-1", 2]]);
    // The policy team still names Acme (auto_shared), but the team may not read it now.
    await t.run(async (ctx) => ctx.db.patch(c1, { is_private: true, team_visibility: "private" }));
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).not.toContain("pri-1");
    expect((await as(bea).query(pri.history, { days: 15 })).lanes).toEqual([]);
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toBeNull();
  });

  test("changing a mapped session's visibility flags its priority for a rewrite at once", async () => {
    const { t, as, bea, p1, c1 } = await world();
    await t.run(async (ctx) => {
      const conv = await ctx.db.get(c1);
      await patchConversationVisibility(ctx as any, conv as any, { is_private: true, team_visibility: "private" });
    });
    expect((await t.run((ctx) => ctx.db.get(p1)))?.needs_rewrite).toBe(true);
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).not.toContain("pri-1");
  });

  test("a priority that needs a rewrite is its owner's alone: no list row, show or pin line for a teammate", async () => {
    const { t, as, ada, bea, p1, c1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(p1, { needs_rewrite: true }));
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).not.toContain("pri-1");
    expect(await as(bea).query(pri.show, { short_id: "pri-1" })).toBeNull();
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toBeNull();
    expect((await rowsOf(as(ada), {})).map((r: any) => r.short_id)).toContain("pri-1");
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1" });
  });

  test("a teammate's access reads only the newest four sessions (failing closed), while the pin line judges the open session alone", async () => {
    const { t, as, ada, bea, acme, p1, c1 } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("conversations", {
          user_id: ada, team_id: acme, agent_type: "claude_code", session_id: `p${i}`, short_id: `jx7pvx${i}`, title: "private",
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, team_visibility: "private", status: "active", priority_id: p1,
        } as any);
      }
    });
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).not.toContain("pri-1");
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1" });
  });

  test("a list judges at most TEAMMATE_PRIORITIES_CAP teammates' priorities, the most recently active, and says so", async () => {
    const { t, ada, bea, acme, ws } = await world();
    const BEA_TOKEN = "cc_test_priorities_bea";
    await t.run(async (ctx) => {
      await ctx.db.insert("api_tokens", { user_id: bea, token_hash: await hashToken(BEA_TOKEN), name: "cli", created_at: NOW, last_used_at: NOW } as any);
      for (let i = 0; i < TEAMMATE_PRIORITIES_CAP; i++) {
        const p = await ctx.db.insert("priorities", {
          user_id: ada, workspace: ws, short_id: `pri-${100 + i}`, title: `More ${i}`, summary: "", status: "active", rank_set_by: "pass",
          steps: [], first_seen_at: NOW, last_active_at: NOW + i, pass_at: NOW, created_at: NOW, updated_at: NOW,
        } as any);
        await ctx.db.insert("conversations", {
          user_id: ada, team_id: acme, agent_type: "claude_code", session_id: `m${i}`, short_id: `jx7m${i}`, title: "m",
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p,
        } as any);
      }
    });
    const res = await t.query(pri.cliList, { api_token: BEA_TOKEN, team_id: acme });
    expect(res.teammates_truncated).toBe(true);
    expect(res.priorities).toHaveLength(TEAMMATE_PRIORITIES_CAP);
    expect(res.priorities.map((r: any) => r.short_id)).not.toContain("pri-1");
  });

  test("a teammate sees a step's refs they may read, and not a step written from a session since locked private", async () => {
    const { t, as, ada, bea, acme, ws, p1, c1 } = await world();
    await t.run(async (ctx) => {
      // Another shared session keeps pri-1 readable once jx7one1 is locked.
      await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "keep", short_id: "jx7keep", title: "kept",
        started_at: NOW, updated_at: NOW - 3 * DAY, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p1,
      } as any);
      for (const [short_id, workspace] of [["ct-1", ws], ["ct-2", `user:${ada}`]] as const) {
        await ctx.db.insert("tasks", { short_id, title: short_id, status: "open", task_type: "task", priority: "medium", source: "human", user_id: ada, workspace, created_at: 1, updated_at: 1 } as any);
      }
      await ctx.db.insert("pull_requests", {
        team_id: acme, github_pr_id: 4, repository: "acme/web", number: 4, title: "PR 4", body: "", state: "open",
        author_github_username: "ada", linked_session_ids: [], created_at: NOW, updated_at: NOW, head_ref: "ada/pr-4",
      } as any);
      await ctx.db.patch(p1, { steps: [
        { key: "s1", title: "From the shared session", tier: "critical", tier_set_by: "pass", refs: [{ kind: "session", id: "jx7one1" }], done: false },
        { key: "s2", title: "Mixed", tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: "ct-1" }, { kind: "task", id: "ct-2" }, { kind: "pr", id: "acme/web#4" }, { kind: "pr", id: "elsewhere/x#1" }], done: false },
      ] });
    });
    const stepsOf = async (who: Id<"users">) => (await as(who).query(pri.show, { short_id: "pri-1" })).steps.map((s: any) => [s.key, s.refs.map((r: any) => r.id)]);
    expect(await stepsOf(bea)).toEqual([["s1", ["jx7one1"]], ["s2", ["ct-1", "acme/web#4"]]]);
    await t.run(async (ctx) => ctx.db.patch(c1, { is_private: true, team_visibility: "private" }));
    expect(await stepsOf(bea)).toEqual([["s2", ["ct-1", "acme/web#4"]]]);
    expect((await rowsOf(as(bea), {})).find((r: any) => r.short_id === "pri-1").steps.map((s: any) => s.key)).toEqual(["s2"]);
    // The owner sees every step whole.
    expect((await stepsOf(ada)).map(([key]: any) => key)).toEqual(["s1", "s2"]);
  });

  test("a member who left the team: their priorities there are read by nobody but them", async () => {
    const { t, as, ada, bea, acme } = await world();
    await t.run(async (ctx) => {
      const membership = (await ctx.db.query("team_memberships").withIndex("by_user_id", (q) => q.eq("user_id", ada)).collect()).find((m) => m.team_id === acme)!;
      await ctx.db.delete(membership._id);
    });
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).toEqual([]);
    expect((await as(bea).query(pri.history, { days: 15 })).lanes).toEqual([]);
  });

  test("the viewer's unassigned lane files a session by the workspace it counts in, not the team it was started under", async () => {
    const { t, as, ada, acme, c2 } = await world();
    const unassigned = async (workspace: string) => (await as(ada).query(pri.history, { days: 15, workspace })).lanes.find((l: any) => l.key === "unassigned")?.total ?? 0;
    expect([await unassigned(`team:${acme}`), await unassigned(`user:${ada}`)]).toEqual([1, 0]);
    await t.run(async (ctx) => ctx.db.patch(c2, { is_private: true, team_visibility: "private" }));
    expect([await unassigned(`team:${acme}`), await unassigned(`user:${ada}`)]).toEqual([0, 1]);
  });

  test("a workflow's run log counts in its team's workspace but is never listed to a teammate", () => {
    const conv = { user_id: "u1", team_id: "t1", is_private: false, team_visibility: "full", started_at: NOW } as any;
    const log = { ...conv, is_workflow_primary: true, workflow_run_id: "w1" };
    expect([sessionSharedWithTeam(conv, "t1", {}, { visibility: "full" }), sessionListedToTeam(conv, "t1", {}, { visibility: "full" })]).toEqual([true, true]);
    expect([sessionSharedWithTeam(log, "t1", {}, { visibility: "full" }), sessionListedToTeam(log, "t1", {}, { visibility: "full" })]).toEqual([true, false]);
  });

  test("the viewer's own are read newest first, at most 200 a status, and the list says when more were there", async () => {
    const { t, ada, ws, acme } = await world();
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("priorities", {
          user_id: ada, workspace: ws, short_id: `pri-${300 + i}`, title: `Old ${i}`, summary: "", status: "done", rank_set_by: "pass",
          steps: [], first_seen_at: 1, last_active_at: NOW - 100 * DAY + i, done_at: NOW - 100 * DAY + i, pass_at: 1, created_at: 1, updated_at: 1,
        } as any);
      }
    });
    const res = await t.query(pri.cliList, { api_token: TOKEN, status: "done", team_id: acme });
    const ids = res.priorities.map((r: any) => r.short_id);
    expect(res.own_truncated).toBe(true);
    expect(ids).toHaveLength(200);
    // pri-4 (done a day ago) and the newest old one are read; the oldest is the one left out.
    expect(ids).toContain("pri-4");
    expect(ids).toContain("pri-500");
    expect(ids).not.toContain("pri-300");
    expect((await t.query(pri.cliList, { api_token: TOKEN, status: "active", team_id: acme })).own_truncated).toBe(false);
  });

  test("a teammate's done priority shows for 60 days, older only with all or a status", async () => {
    const { t, as, bea, ws, p4 } = await world();
    await t.run(async (ctx) => ctx.db.patch(p4, { last_active_at: NOW - 90 * DAY, done_at: NOW - 90 * DAY }));
    const ids = async (args: any) => (await rowsOf(as(bea), { workspace: ws, ...args })).map((r: any) => r.short_id);
    expect(await ids({})).not.toContain("pri-4");
    expect(await ids({ all: true })).toContain("pri-4");
    expect(await ids({ status: "done" })).toEqual(["pri-4"]);
  });

  test("a co-owner of a session sees no pin line for a personal priority", async () => {
    const { t, as, ada, bea, c4 } = await world();
    await t.run(async (ctx) => ctx.db.insert("session_owners", { conversation_id: c4, user_id: bea, added_by: ada, added_at: NOW }));
    expect(await as(bea).query(pri.pinLine, { conversation_id: c4 })).toBeNull();
  });

  test("the pin line shows to a teammate the session is listed to at summary level", async () => {
    const { t, as, bea, c1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(c1, { team_visibility: "summary" }));
    expect(await as(bea).query(pri.pinLine, { conversation_id: c1 })).toMatchObject({ short_id: "pri-1" });
  });

  test("history: a teammate's lane skips messages in a session no longer visible to the team", async () => {
    const { t, as, bea, c1, p1, ada, acme } = await world();
    await t.run(async (ctx) => {
      await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "s8", short_id: "jx7vis8", title: "still shared",
        started_at: NOW, updated_at: NOW - DAY, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p1,
      } as any);
      await ctx.db.patch(c1, { is_private: true, team_visibility: "private" });
    });
    // pri-1 still reads (through the shared session), but Ada's typing in the now-private one is not counted.
    expect((await rowsOf(as(bea), {})).map((r: any) => r.short_id)).toContain("pri-1");
    expect((await as(bea).query(pri.history, { days: 15 })).lanes).toEqual([]);
  });

  test("history: with no teammates' lanes the viewer's read takes the whole budget, and a cut marks every visible lane of theirs", async () => {
    const { t, as, ada, bea, acme, c2 } = await world();
    await t.run(async (ctx) => {
      const message = await ctx.db.insert("messages", { conversation_id: c2, role: "user", content: "x", timestamp: NOW } as any);
      for (let i = 0; i < HISTORY_SENDS_CAP; i++) {
        await ctx.db.insert("user_sends", { user_id: ada, team_id: acme, conversation_id: c2, message_id: message, timestamp: NOW - 1_000 - i, words: 1, text: "x", clipped: false } as any);
      }
    });
    const res = await as(ada).query(pri.history, { days: 15, workspace: `team:${acme}` });
    // Newest first: the whole budget of what she just typed (nobody else's lanes share it), none of the older ones.
    expect(res.lanes.map((l: any) => [l.key, l.total, l.truncated])).toEqual([
      ["pri-1", 0, true], ["pri-2", 0, true], ["pri-3", 0, true], ["pri-4", 0, true], ["unassigned", HISTORY_SENDS_CAP, true],
    ]);
    // Bea, who typed nothing, gives Ada's share the whole budget: still cut, and only Ada's lanes say so.
    const theirs = await as(bea).query(pri.history, { days: 15 });
    expect(theirs.lanes.map((l: any) => [l.key, l.total, l.truncated])).toEqual([["pri-1", 0, true], ["pri-2", 0, true], ["pri-3", 0, true], ["pri-4", 0, true]]);
  });

  test("history: many sharing teammates split what the viewer leaves, never past the budget", async () => {
    const { t, as, ada, bea, acme, ws, c1 } = await world();
    const TEAMMATE_SENDS = 1_600;
    await t.run(async (ctx) => {
      const dee = await ctx.db.insert("users", { name: "Dee" } as any);
      await ctx.db.insert("team_memberships", { user_id: dee, team_id: acme, role: "member", joined_at: 1 } as any);
      const p = await ctx.db.insert("priorities", {
        user_id: dee, workspace: ws, short_id: "pri-20", title: "Dee's", summary: "", status: "active", rank_set_by: "pass",
        steps: [], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      } as any);
      const c = await ctx.db.insert("conversations", {
        user_id: dee, team_id: acme, agent_type: "claude_code", session_id: "dee", short_id: "jx7dee9", title: "dee",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p,
      } as any);
      for (const [user, conv] of [[ada, c1], [dee, c]] as const) {
        const message = await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "x", timestamp: NOW } as any);
        for (let i = 0; i < TEAMMATE_SENDS; i++) {
          await ctx.db.insert("user_sends", { user_id: user, team_id: acme, conversation_id: conv, message_id: message, timestamp: NOW - 1_000 - i, words: 1, text: "x", clipped: false } as any);
        }
      }
    });
    const res = await as(bea).query(pri.history, { days: 15 });
    const lane = (key: string) => res.lanes.find((l: any) => l.key === key);
    // Bea's own read used 3; the two teammates split the rest evenly.
    const share = Math.floor((HISTORY_SENDS_CAP - 3) / 2);
    expect([lane("pri-1").total, lane("pri-1").truncated, lane("pri-20").total, lane("pri-20").truncated]).toEqual([share, true, share, true]);
    expect(res.lanes.reduce((sum: number, l: any) => sum + l.total, 0)).toBeLessThanOrEqual(HISTORY_SENDS_CAP);
  });

  test("a priority someone cannot see answers the same whether or not its feature is on", async () => {
    const { t } = await world();
    expect(await t.query(pri.cliShow, { api_token: CY_TOKEN, short_id: "pri-6" })).toEqual({ error: "no priority pri-6 you can see" });
    expect(await t.query(pri.cliShow, { api_token: CY_TOKEN, short_id: "pri-1" })).toEqual({ error: "no priority pri-1 you can see" });
  });

  test("a teammate sharing summaries sees the sessions of a priority, its count and its chips", async () => {
    const { t, as, bea, c1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(c1, { team_visibility: "summary" }));
    const [row] = await rowsOf(as(bea), {});
    expect(row).toMatchObject({ short_id: "pri-1", session_count: 1 });
    expect(row.sessions.map((s: any) => s.short_id)).toEqual(["jx7one1"]);
    expect((await as(bea).query(pri.show, { short_id: "pri-1" })).steps.find((s: any) => s.key === "s2").sessions.map((s: any) => s.short_id)).toEqual(["jx7one1"]);
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
    expect(await rowsOf(as(ada), { workspace: `team:${off}` })).toEqual([]);
    expect((await rowsOf(as(ada), {})).map((r: any) => r.short_id)).not.toContain("pri-6");
    expect(await as(ada).query(pri.show, { short_id: "pri-6" })).toBeNull();
    expect(await t.query(pri.cliShow, { api_token: TOKEN, short_id: "pri-6" })).toEqual({ error: teamFeatureOffMessage("priorities") });
    await t.run(async (ctx) => ctx.db.patch(c1, { priority_id: dark }));
    expect(await as(ada).query(pri.pinLine, { conversation_id: c1 })).toBeNull();
    const offHistory = await as(ada).query(pri.history, {});
    expect(offHistory.lanes.map((l: any) => l.key)).toEqual(["unassigned"]);
    expect(offHistory.sessions).toEqual({});
  });
});

describe("writes", () => {
  const ranks = (t: any, ids: Id<"priorities">[]) => t.run(async (ctx: any) => Promise.all(ids.map(async (id) => {
    const p = await ctx.db.get(id);
    return [p.short_id, p.rank ?? null, p.rank_set_by];
  })));

  const positions = async (as: any) => (await rowsOf(as, { status: "active" })).filter((r: any) => r.workspace.startsWith("team:")).map((r: any) => `${r.rank}:${r.short_id}`);

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
    // A chain: pri-2 to #2 pushes pri-3 to 3, which pushes pri-1 to 4; pri-3 first takes the
    // slot it shows at (#1 once pri-2 leaves the order), so pri-3 ends #1 and pri-1 #3.
    expect(await as(ada).mutation(pri.rank, { short_id: "pri-2", rank: 2 })).toMatchObject({ rank: 2 });
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-2", "3:pri-1"]);
  });

  test("rank is the position the person sees: a slot past the end counts as where it shows", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.rank, { short_id: "pri-3", rank: 1 });
    await t.run(async (ctx) => ctx.db.patch(p1, { rank: 99, rank_set_by: "person" }));
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-2", "3:pri-1"]);
    expect(await as(ada).mutation(pri.rank, { short_id: "pri-2", rank: 3 })).toMatchObject({ short_id: "pri-2", rank: 3 });
    expect(await positions(as(ada))).toEqual(["1:pri-3", "2:pri-1", "3:pri-2"]);
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 2, "person"], ["pri-2", 3, "person"], ["pri-3", 1, "person"]]);
    // Past the end is the last position.
    expect(await as(ada).mutation(pri.rank, { short_id: "pri-3", rank: 10 })).toMatchObject({ rank: 3 });
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

  test("set aside leaves the ranking; restore brings it back after the pass-ranked ones", async () => {
    const { t, as, ada, p1, p2, p3 } = await world();
    await as(ada).mutation(pri.setAside, { short_id: "pri-1" });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", null, "pass"], ["pri-2", 2, "pass"], ["pri-3", null, "pass"]]);
    expect((await t.run(async (ctx) => ctx.db.get(p1)))!.status).toBe("set_aside");
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-3"]);
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-1" })).toMatchObject({ short_id: "pri-1", status: "active", rank: 2 });
    expect(await ranks(t, [p1, p2, p3])).toEqual([["pri-1", 3, "pass"], ["pri-2", 2, "pass"], ["pri-3", null, "pass"]]);
    expect(await positions(as(ada))).toEqual(["1:pri-2", "2:pri-1", "3:pri-3"]);
    await expect(as(ada).mutation(pri.restore, { short_id: "pri-1" })).rejects.toThrow("pri-1 is active; only a set-aside or done priority is restored");
    // Reopening one the pass marked done is the person's call: the pass keeps it open.
    expect(await t.mutation(pri.cliRestore, { api_token: TOKEN, short_id: "pri-4" })).toMatchObject({ short_id: "pri-4", status: "active", status_set_by: "person", done_at: null });
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

  test("run says why runNow would refuse, and schedules nothing", async () => {
    const { t, ada, acme, ws } = await world();
    await t.run(async (ctx) => ctx.db.insert("priority_pass_runs", {
      user_id: ada, workspace: ws, started_at: Date.now() - 90_000, finished_at: Date.now(), status: "ok", cursor_at: 0, model: "m", cost_usd: 0.1,
      counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 },
    }));
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme })).toEqual({ error: "A pass ran here 2 minutes ago; run it again in 9 minutes." });
    await t.run(async (ctx) => ctx.db.insert("priority_pass_runs", {
      user_id: ada, workspace: ws, started_at: Date.now() - 60 * 60_000, finished_at: Date.now(), status: "ok", cursor_at: 0, model: "m", cost_usd: 2,
      counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 },
    }));
    await t.run(async (ctx) => { for (const r of await ctx.db.query("priority_pass_runs").collect()) if (r.cost_usd === 0.1) await ctx.db.delete(r._id); });
    expect(await t.mutation(pri.cliRun, { api_token: TOKEN, team_id: acme })).toEqual({ error: "Passes here spent today's $1.50; the next one can run tomorrow." });
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
