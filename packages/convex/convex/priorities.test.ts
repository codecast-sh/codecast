// Priorities API reads (priorities.ts, priorityRead.ts, priorityHistory.ts):
// who reads a priority, what history counts and the pin line. The owner's
// controls are priorities.writes.test.ts.
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { HISTORY_SENDS_CAP, TEAMMATE_PRIORITIES_CAP } from "./priorityRead";
import { sessionListedToTeam, sessionSharedWithTeam } from "./lib/prioritySessionVisibility";
import { sessionPriorityReader } from "./lib/sessionPriority";
import { linkFromStart } from "./lib/priorityLinks";
import { readerFor } from "./lib/priorityAccess";
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
        user_id: ada, workspace: ws, short_id: "pri-7", title: "Long done", summary: "", status: "done", steps: [],
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
    // Nothing asked for a pass yet: none is pending.
    expect(before.next_pass_at).toBeNull();
    await t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: ada, workspace: ws, started_at: NOW - 9 * 3_600_000, finished_at: NOW - 9 * 3_600_000, status: "ok", cursor_at: NOW - 8 * 3_600_000, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    expect(Math.floor((await meta()).behind_by_ms! / 3_600_000)).toBe(8);
    // Activity schedules one: the list says when it runs.
    const due = await t.mutation((internal as any).priorityPassSchedule.request, { user_id: ada, workspace: ws });
    expect(due).toBeGreaterThan(Date.now());
    expect((await meta()).next_pass_at).toBe(due);
    await t.run((ctx) => ctx.db.insert("priority_pass_runs", { user_id: ada, workspace: ws, started_at: Date.now(), finished_at: Date.now(), status: "running", cursor_at: NOW - 8 * 3_600_000, model: "m", counts: { created: 0, updated: 0, merged: 0, mapped_sessions: 0 } }));
    expect((await meta()).next_pass_at!).toBeLessThanOrEqual(Date.now());
    await t.run(async (ctx) => { for (const j of await ctx.db.system.query("_scheduled_functions").collect()) if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id); });
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

  test("every readable active row carries each step's sessions (state, mine, workflow, why), its plans, Looks done and pending corrections; a past one does not", async () => {
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
      // Bea's session works Ada's task and asks Bea something: it reads needs-you to Ada too, though it is not hers.
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
    // s2: Bea's blocked session reports needs-you, not Ada's, and ranks first: a teammate's ask reads as the viewer's own would.
    expect(links.s2.sessions.map((s: any) => [s.short_id, s.state, s.mine, s.why])).toEqual([
      ["jx7bea1", "needs_you", false, ["via ct-902"]],
      ["jx7prk1", "dormant", true, ["linked"]],
      ["jx7one1", "idle", true, ["mapped"]],
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
    // A teammate's active row carries links as the owner's does, each session only if listed to them; a past row carries none.
    const [theirs] = await rowsOf(as(bea), { workspace: ws });
    const theirLinks = Object.fromEntries(theirs.links.map((l: any) => [l.key, l]));
    expect(theirLinks.s1.sessions.map((s: any) => [s.short_id, s.state, s.mine])).toEqual([["jx7ask1", "needs_you", false], ["jx7run1", "killed", false]]);
    expect(theirLinks.s2.sessions.map((s: any) => [s.short_id, s.state, s.mine])).toEqual([["jx7bea1", "needs_you", true], ["jx7prk1", "dormant", false], ["jx7one1", "idle", false]]);
    expect(theirs.plan).toMatchObject({ short_id: "pl-1075" });
    const past = (await rowsOf(as(ada), { workspace: ws })).find((r: any) => r.short_id === "pri-4");
    expect(past.links).toBeUndefined();
    // `show` (the page and the reference card) carries the same links and plan, on any priority the viewer can read.
    const shown = await as(ada).query(pri.show, { short_id: "pri-1" });
    expect(shown.links).toEqual(row.links);
    expect(shown.plan).toEqual(row.plan);
    expect(Array.isArray((await as(ada).query(pri.show, { short_id: "pri-4" })).links)).toBe(true);
    // A teammate reading the page learns of no correction waiting: corrections are the owner's alone.
    const beaShown = await as(bea).query(pri.show, { short_id: "pri-1" });
    expect(beaShown.links.map((l: any) => l.correction_pending)).toEqual([false, false, false]);
    expect(beaShown.correction_pending).toBe(false);
  });

  test("a milestone's capped sessions keep every live one: closed sessions are cut first, never a live workflow run", async () => {
    const { t, as, ada, acme, ws, p1, c1 } = await world();
    await t.run(async (ctx) => {
      const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
        started_at: NOW, updated_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active",
        priority_id: p1, priority_step_key: "s2", ...fields,
      } as any);
      // Six of the person's sessions, all closed and newer than the run.
      for (let i = 0; i < 6; i++) await conv(`jx7cl${i}`, { inbox_killed_at: NOW, updated_at: NOW - i * 1000 });
      // One live review a workflow ran, older than all of them.
      await conv("jx7rvw1", { title: "Review · ct-901 tidy", is_subagent: true, parent_conversation_id: c1, updated_at: NOW - DAY });
    });
    const [row] = await rowsOf(as(ada), { workspace: ws });
    const s2 = row.links.find((l: any) => l.key === "s2");
    const shown = s2.sessions.map((s: any) => s.short_id);
    // The live ones lead (the person's mapped session, then the run); the closed fill the rest, and the cut takes only closed ones.
    expect(shown.slice(0, 2)).toEqual(["jx7one1", "jx7rvw1"]);
    expect(shown).toHaveLength(6);
    expect(s2.sessions.slice(2).every((s: any) => s.state === "killed" || s.state === "done")).toBe(true);
    expect(s2.sessions_more).toBe(2);
  });

  test("the cap never cuts a live session: six old sleeping ones and the newest idle one are all sent", async () => {
    const { t, as, ada, acme, ws, p1 } = await world();
    await t.run(async (ctx) => {
      const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
        started_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active",
        priority_id: p1, priority_step_key: "s2", ...fields,
      } as any);
      for (let i = 0; i < 6; i++) await conv(`jx7sl${i}`, { thread_state_status: "dormant", thread_state_at: NOW - (3 + i) * DAY, last_turn_at: NOW - (3 + i) * DAY, updated_at: NOW - (3 + i) * DAY });
      await conv("jx7new1", { updated_at: NOW });
      await conv("jx7cls1", { inbox_killed_at: NOW, updated_at: NOW - 1000 });
    });
    const [row] = await rowsOf(as(ada), { workspace: ws });
    const s2 = row.links.find((l: any) => l.key === "s2");
    const shown = s2.sessions.map((s: any) => s.short_id);
    for (const id of ["jx7new1", "jx7one1", ...Array.from({ length: 6 }, (_, i) => `jx7sl${i}`)]) expect(shown).toContain(id);
    // Eight live sessions fill past the six: the closed one is the only cut, and the only one counted as more.
    expect(shown).not.toContain("jx7cls1");
    expect(s2.sessions_more).toBe(1);
  });

  test("a session settled done reads closed only while the verdict is current: once it works again it is live", async () => {
    const { t, as, ada, acme, ws, p1 } = await world();
    await t.run(async (ctx) => {
      const conv = (short_id: string, fields: Record<string, unknown>) => ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: `Session ${short_id}`,
        started_at: NOW, message_count: 3, is_private: false, team_visibility: "full", status: "active",
        priority_id: p1, priority_step_key: "s2", ...fields,
      } as any);
      // Settled done, nothing since; and settled done a day ago, working again now.
      await conv("jx7setl", { settle_verdict: "done", settle_verdict_at: NOW, updated_at: NOW - 1000 });
      await conv("jx7agan", { settle_verdict: "done", settle_verdict_at: NOW - DAY, updated_at: NOW });
    });
    const [row] = await rowsOf(as(ada), { workspace: ws });
    const states = Object.fromEntries(row.links.find((l: any) => l.key === "s2").sessions.map((s: any) => [s.short_id, s.state]));
    expect(states.jx7setl).toBe("done");
    expect(states.jx7agan).toBe("idle");
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

  test("a teammate reads the owner's order numbered over what they can read, in the list, on the page, on the pin line and on a session's priority alike, so the owner's hidden #1 leaves no gap", async () => {
    const { t, as, ada, bea, acme, ws, p1 } = await world();
    await t.run(async (ctx) => ctx.db.patch(p1, { needs_rewrite: true }));
    const pin = await t.run(async (ctx) => (await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jx7two5")).first())!._id);
    const theirs = await rowsOf(as(bea), { workspace: ws });
    expect(theirs.filter((r: any) => r.status === "active").map((r: any) => [r.short_id, r.rank])).toEqual([["pri-2", 1], ["pri-3", 2]]);
    const listed = theirs.find((r: any) => r.short_id === "pri-2");
    const shown = await as(bea).query(pri.show, { short_id: "pri-2" });
    // The position alone: not the scale behind it, not who set it.
    for (const row of [listed, shown]) expect([row.rank, row.person_pos, row.ai_rank, row.rank_source]).toEqual([1, null, null, null]);
    expect((await as(bea).query(pri.pinLine, { conversation_id: pin }))?.rank).toBe(1);
    // A read of every workspace numbers them the same.
    expect((await rowsOf(as(bea), {})).find((r: any) => r.short_id === "pri-2").rank).toBe(1);
    // The owner reads the same rank from all three.
    const ref = await t.run(async (ctx) => (await sessionPriorityReader(ctx, bea, acme))(await ctx.db.get(pin)));
    expect(ref).toEqual({ id: "pri-2", title: "Priority pri-2", rank: 1, user_id: String(ada) });
    const own = (await rowsOf(as(ada), { workspace: ws })).find((r: any) => r.short_id === "pri-2");
    expect([own.rank, (await as(ada).query(pri.show, { short_id: "pri-2" })).rank, (await as(ada).query(pri.pinLine, { conversation_id: pin })).rank]).toEqual([2, 2, 2]);
    expect([own.ai_rank, own.rank_source]).toEqual([2, "ai"]);
    expect(await t.run(async (ctx) => (await sessionPriorityReader(ctx, ada, acme))(await ctx.db.get(pin)))).toEqual(ref);
    // A write's echo carries the place, and a teammate's next read follows it.
    expect(await as(ada).mutation(pri.moveTo, { short_id: "pri-2", to: 1 })).toMatchObject({ rank: 1, rank_source: "person" });
    expect((await rowsOf(as(bea), { workspace: ws })).find((r: any) => r.short_id === "pri-2")).toMatchObject({ rank: 1, rank_source: "person" });
  });

  test("a row carries its owner's face: their own photo, else GitHub's, else none", async () => {
    const { t, as, ada, bea, ws } = await world();
    const face = async () => [(await rowsOf(as(bea), { workspace: ws }))[0].owner_image, (await as(bea).query(pri.show, { short_id: "pri-2" })).owner_image];
    expect(await face()).toEqual([null, null]);
    await t.run(async (ctx) => ctx.db.patch(ada, { github_avatar_url: "https://gh/ada.png" }));
    expect(await face()).toEqual(["https://gh/ada.png", "https://gh/ada.png"]);
    await t.run(async (ctx) => ctx.db.patch(ada, { image: "https://photo/ada.png" }));
    expect(await face()).toEqual(["https://photo/ada.png", "https://photo/ada.png"]);
    expect(await as(ada).mutation(pri.moveTo, { short_id: "pri-2", to: 1 })).toMatchObject({ owner: "Ada", owner_image: "https://photo/ada.png" });
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
          user_id: ada, workspace: ws, short_id: `pri-${100 + i}`, title: `More ${i}`, summary: "", status: "active",
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

  test("the teammate cap holds per workspace: a read of every workspace returns for each what a read of that one returns", async () => {
    const { t, as, ada, bea, acme, ws } = await world();
    const beta = await t.run(async (ctx) => {
      const beta = await ctx.db.insert("teams", { name: "Beta", created_at: NOW, features: { priorities: true } } as any);
      for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: beta, role: "member", joined_at: 1 } as any);
      const priority = (workspace: string, short_id: string, last_active_at: number) => ctx.db.insert("priorities", {
        user_id: ada, workspace, short_id, title: short_id, summary: "", status: "active", steps: [], first_seen_at: NOW - 40 * DAY, last_active_at, pass_at: NOW, created_at: NOW, updated_at: NOW,
      } as any);
      const listed = (team: Id<"teams">, short_id: string, priority_id: Id<"priorities">) => ctx.db.insert("conversations", {
        user_id: ada, team_id: team, agent_type: "claude_code", session_id: short_id, short_id, title: short_id,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id,
      } as any);
      // Older than every Acme priority, so one cap across both workspaces would crowd it out.
      await listed(beta, "jx7lite", await priority(`team:${beta}`, "pri-90", NOW - 30 * DAY));
      for (let i = 0; i < TEAMMATE_PRIORITIES_CAP; i++) await listed(acme, `jx7h${i}`, await priority(ws, `pri-${100 + i}`, NOW + i));
      return beta;
    });
    const acmeOnly = await as(bea).query(pri.list, { workspace: ws });
    const everywhere = await as(bea).query(pri.list, {});
    const inAcme = (res: any) => res.priorities.filter((r: any) => r.workspace === ws).map((r: any) => [r.short_id, r.rank]);
    expect([acmeOnly.teammates_truncated, everywhere.teammates_truncated]).toEqual([true, true]);
    expect(inAcme(acmeOnly)).toHaveLength(TEAMMATE_PRIORITIES_CAP);
    expect(inAcme(everywhere)).toEqual(inAcme(acmeOnly));
    expect(everywhere.priorities.filter((r: any) => r.workspace === `team:${beta}`).map((r: any) => [r.short_id, r.rank])).toEqual([["pri-90", 1]]);
  });

  test("Start on a teammate's milestone links the new session when the starter can read the priority and milestone, and is refused otherwise", async () => {
    const { t, as, ada, bea, acme, off, ws, p1, dark } = await world();
    let n = 0;
    const start = (short_id: string, step?: string, fields: Record<string, unknown> = {}, starter: Id<"users"> = bea) => t.run(async (ctx) => {
      const conv = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: `start-${n}`, short_id: `jx7st${n++}`, title: "started",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      } as any);
      return { linked: await linkFromStart(ctx, starter, conv, short_id, step), conv: (await ctx.db.get(conv))! };
    });
    const ok = await start("pri-1", "s2");
    expect(ok.linked).toBe(true);
    expect(ok.conv).toMatchObject({ priority_id: p1, priority_step_key: "s2", priority_set_by: "link" });
    // The owner sees it on that milestone, not hers.
    const [row] = await rowsOf(as(ada), { workspace: ws });
    expect(row.links.find((l: any) => l.key === "s2").sessions.find((s: any) => s.short_id === ok.conv.short_id)).toMatchObject({ mine: false, why: ["mapped"] });
    const refused = async (...args: Parameters<typeof start>) => {
      const res = await start(...args);
      expect(res.linked).toBe(false);
      expect(res.conv.priority_id).toBeUndefined();
    };
    // Ada's personal priority, and one in a team Bea is not in: not hers to read.
    await refused("pri-5");
    await refused("pri-6");
    // A session that is not the starter's, and one of hers in another workspace.
    await refused("pri-1", "s2", {}, ada);
    await refused("pri-1", "s2", { team_id: undefined, is_private: true, team_visibility: "private" });
    // A milestone written from a session Bea cannot see is hidden from her: no Start on it.
    await t.run(async (ctx) => {
      const p = (await ctx.db.get(p1))!;
      await ctx.db.patch(p1, { steps: [...p.steps, { ...step("s4", "polish"), refs: [{ kind: "session", id: "jx7pvt3" }] }] });
    });
    await refused("pri-1", "s4");
    // Priorities off in a team Bea is in, though she can read the priority: refused until it is on.
    await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: bea, team_id: off, role: "member", joined_at: 1 } as any);
      await ctx.db.insert("conversations", {
        user_id: ada, team_id: off, agent_type: "claude_code", session_id: "off-1", short_id: "jx7off1", title: "off",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: dark,
      } as any);
    });
    expect(await t.run(async (ctx) => (await readerFor(ctx, bea)).canRead((await ctx.db.get(dark))!))).toBe(true);
    await refused("pri-6", undefined, { team_id: off });
    await t.run(async (ctx) => ctx.db.patch(off, { features: { priorities: true } } as any));
    expect((await start("pri-6", undefined, { team_id: off })).linked).toBe(true);
    // One that needs a rewrite is its owner's alone.
    await t.run(async (ctx) => ctx.db.patch(p1, { needs_rewrite: true }));
    await refused("pri-1", "s2");
  });

  test("a teammate's Start never keeps a priority readable once its owner stops sharing", async () => {
    const { t, as, ada, bea, cy, acme, ws, p1 } = await world();
    const { started, adaMember } = await t.run(async (ctx) => {
      await ctx.db.insert("team_memberships", { user_id: cy, team_id: acme, role: "member", joined_at: 1 } as any);
      const started = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: "start-1", short_id: "jx7beas", title: "started",
        started_at: NOW, updated_at: NOW + 1, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, started, "pri-1", "s2")).toBe(true);
      const adaMember = (await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", ada).eq("team_id", acme)).first())!._id;
      return { started, adaMember };
    });
    const cyReads = async () => (await rowsOf(as(cy), { workspace: ws })).map((r: any) => r.short_id);
    expect(await cyReads()).toContain("pri-1");
    // Ada leaves the team: her sessions are no longer listed to it, and Bea's on pri-1 opens nothing.
    await t.run(async (ctx) => ctx.db.delete(adaMember));
    expect(await cyReads()).toEqual([]);
    expect(await as(cy).query(pri.show, { short_id: "pri-1" })).toBeNull();
    expect(await as(cy).query(pri.pinLine, { conversation_id: started })).toBeNull();
    expect(await t.run(async (ctx) => (await readerFor(ctx, cy)).canRead((await ctx.db.get(p1))!))).toBe(false);
  });

  test("a teammate's Start can be undone by either side, and the priority it left is counted again", async () => {
    const { t, as, ada, bea, acme, p1 } = await world();
    const startOn = (short_id: string) => t.run(async (ctx) => {
      const conv = await ctx.db.insert("conversations", {
        user_id: bea, team_id: acme, agent_type: "claude_code", session_id: short_id, short_id, title: "started",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      } as any);
      expect(await linkFromStart(ctx, bea, conv, "pri-1", "s2")).toBe(true);
      return conv;
    });
    const conv = (id: Id<"conversations">) => t.run(async (ctx) => (await ctx.db.get(id))!);
    const count = () => t.run(async (ctx) => (await ctx.db.get(p1))!.session_count);
    await t.run(async (ctx) => ctx.db.patch(p1, { session_count: 2 }));
    // Bea says her session is not part of Ada's priority: it leaves and never maps there again.
    const mine = await startOn("jx7bst1");
    expect(await count()).toBe(3);
    await as(bea).mutation(pri.sessionNotThis, { session: "jx7bst1" });
    const left = await conv(mine);
    expect([left.priority_id, left.priority_not]).toEqual([undefined, [p1]]);
    expect(await count()).toBe(2);
    // Ada says Bea's session is not part of hers: unlinked only, Bea's own word on it is left alone.
    const theirs = await startOn("jx7bst2");
    await as(ada).mutation(pri.sessionNotThis, { session: "jx7bst2" });
    const after = await conv(theirs);
    expect([after.priority_id, after.priority_not]).toEqual([undefined, undefined]);
    expect(await count()).toBe(2);
    // Bea moves a started session onto a priority of her own: Ada's count drops.
    const moved = await startOn("jx7bst3");
    const beas = await t.run(async (ctx) => ctx.db.insert("priorities", {
      user_id: bea, workspace: (await ctx.db.get(p1))!.workspace, short_id: "pri-80", title: "Bea's", summary: "", status: "active", steps: [],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, session_count: 0,
    } as any));
    await as(bea).mutation(pri.moveSession, { session: "jx7bst3", short_id: "pri-80" });
    expect((await conv(moved)).priority_id).toBe(beas);
    expect(await count()).toBe(2);
    // Neither may touch a session that is neither theirs nor on a priority of theirs.
    await expect(as(bea).mutation(pri.sessionNotThis, { session: "jx7one1" })).rejects.toThrow();
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
    // The pin line of the shared session on s1 names no step to her, and names it to the owner.
    const keep = await t.run(async (ctx) => {
      const id = (await ctx.db.query("conversations").withIndex("by_short_id", (q) => q.eq("short_id", "jx7keep")).first())!._id;
      await ctx.db.patch(id, { priority_step_key: "s1" } as any);
      return id;
    });
    const beaPin = await as(bea).query(pri.pinLine, { conversation_id: keep });
    expect(beaPin?.short_id).toBe("pri-1");
    expect(beaPin?.step_title).toBeUndefined();
    expect((await as(ada).query(pri.pinLine, { conversation_id: keep }))?.step_title).toBe("From the shared session");
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
          user_id: ada, workspace: ws, short_id: `pri-${300 + i}`, title: `Old ${i}`, summary: "", status: "done",
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
        user_id: dee, workspace: ws, short_id: "pri-20", title: "Dee's", summary: "", status: "active",
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
