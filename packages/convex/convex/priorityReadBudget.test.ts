// A list of every workspace stays under Convex's per-query read cap (4,096
// db calls) at its worst: two team workspaces at the teammate cap, each
// priority's milestones naming tasks with sessions, and the viewer's own
// with links (priorityRead.ts listFor, TEAMMATE_LINKED); and with `all`,
// whose bigger cap holds across every workspace together.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { TEAMMATE_ALL_CAP, TEAMMATE_LINKED, TEAMMATE_PRIORITIES_CAP, listFor } from "./priorityRead";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(180_000);

const NOW = Date.now();
const OWN = 30;

/** ctx with a db that counts each get and each query it runs (first, take, collect, unique, paginate). */
function counting(ctx: any): { ctx: any; calls: () => number } {
  let calls = 0;
  const TERMINAL = new Set(["first", "take", "collect", "unique", "paginate"]);
  const wrapQuery = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        if (TERMINAL.has(String(prop))) calls++;
        const out = v.apply(target, args);
        return out && typeof out === "object" && typeof out.then !== "function" ? wrapQuery(out) : out;
      };
    },
  });
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "get") return (...args: any[]) => (calls++, v.apply(target, args));
      if (prop === "query") return (...args: any[]) => wrapQuery(v.apply(target, args));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, db }, calls: () => calls };
}

/**
 * Ada and Bea share `teamNames` (Acme first). Ada has `perTeam` active
 * priorities in each, ranked 1..perTeam, and one more in Acme ranked last but
 * the most recently active (`late`), with a session asking on s3; Bea has OWN
 * in Acme.
 */
async function world(perTeam: number, teamNames = ["Acme", "Beta"]) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const ada = await ctx.db.insert("users", { name: "Ada" });
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const teams: Id<"teams">[] = [];
    for (const name of teamNames) {
      const team = await ctx.db.insert("teams", { name, created_at: NOW, features: { priorities: true } });
      for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
      teams.push(team);
    }
    let n = 0;
    const conv = (owner: Id<"users">, team: Id<"teams">, fields: Record<string, unknown> = {}) => {
      const sid = `jx7c${n++}`;
      return ctx.db.insert("conversations", {
        user_id: owner, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      });
    };
    // Four milestones, each naming a task with two sessions, and five mapped sessions.
    const priority = async (owner: Id<"users">, team: Id<"teams">, rank: number) => {
      const ws = `team:${team}`;
      const steps = [];
      for (let s = 1; s <= 4; s++) {
        const short_id = `ct-${n++}`;
        await ctx.db.insert("tasks", {
          user_id: owner, team_id: team, workspace: ws, short_id, title: short_id, status: "open",
          conversation_ids: [await conv(owner, team), await conv(owner, team)], created_at: NOW, updated_at: NOW,
        });
        steps.push({ key: `s${s}`, title: `Milestone ${s}`, tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: short_id }], done: false });
      }
      const p = await ctx.db.insert("priorities", {
        user_id: owner, workspace: ws, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank, steps,
        first_seen_at: NOW, last_active_at: NOW - rank, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      for (let m = 0; m < 5; m++) await conv(owner, team, { priority_id: p, priority_step_key: `s${(m % 4) + 1}` });
      return p;
    };
    for (const team of teams) for (let rank = 1; rank <= perTeam; rank++) await priority(ada, team, rank);
    for (let rank = 1; rank <= OWN; rank++) await priority(bea, teams[0], rank);
    const late = await priority(ada, teams[0], perTeam + 1);
    await ctx.db.patch(late, { last_active_at: NOW + 10 });
    await conv(ada, teams[0], { priority_id: late, priority_step_key: "s3", thread_state_status: "blocked", thread_state_at: NOW, last_turn_at: NOW - 1000, updated_at: NOW + 1 });
    return { bea, late };
  });
  /** Bea's list of every workspace, and the db calls it made. */
  const listed = (args: { all?: boolean } = {}) => t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, ids.bea, args);
    return { list, calls: counted.calls() };
  });
  return { ...ids, listed };
}

test("a list of every workspace at the teammate cap stays well under the read cap, and a teammate's priority past the link budget still reports its mapped sessions", async () => {
  const { late, listed } = await world(TEAMMATE_PRIORITIES_CAP);
  const { list, calls } = await listed();
  console.log(`priority list worst case: ${calls} db calls for ${list.priorities.length} rows`);
  expect(list.priorities.filter((r: any) => r.mine)).toHaveLength(OWN);
  expect(list.priorities.filter((r: any) => !r.mine && r.links)).toHaveLength(2 * TEAMMATE_PRIORITIES_CAP);
  expect(calls).toBeLessThan(3_000);

  // Full links reach a task's sessions; only TEAMMATE_LINKED teammates' priorities, every #1 first.
  const viaTask = (r: any) => r.links.some((l: any) => l.sessions.some((s: any) => s.why.some((w: string) => w.startsWith("via "))));
  const teammates = list.priorities.filter((r: any) => !r.mine);
  expect(teammates.filter(viaTask)).toHaveLength(TEAMMATE_LINKED);
  expect(teammates.filter((r: any) => r.rank === 1).every(viaTask)).toBe(true);
  expect(list.priorities.filter((r: any) => r.mine).every(viaTask)).toBe(true);

  // Past the budget: linked from its mapped sessions alone, the asking one on its milestone.
  const row = list.priorities.find((r: any) => String(r._id) === String(late));
  expect(row.rank).toBe(TEAMMATE_PRIORITIES_CAP + 1);
  expect(viaTask(row)).toBe(false);
  expect(row.plan).toBeNull();
  const s3 = row.links.find((l: any) => l.key === "s3");
  expect(s3.sessions[0]).toMatchObject({ state: "needs_you", mine: false, why: ["mapped"] });
});

test("with all, teammates' priorities are capped across every workspace together, so the bigger cap stays under the read cap", async () => {
  // Each of three workspaces holds the cap: a cap per workspace would list three times as many, past 3,000 reads.
  const { listed } = await world(TEAMMATE_ALL_CAP, ["Acme", "Beta", "Gamma"]);
  const { list, calls } = await listed({ all: true });
  console.log(`priority list with all: ${calls} db calls for ${list.priorities.length} rows`);
  const teammates = list.priorities.filter((r: any) => !r.mine);
  expect(list.teammates_truncated).toBe(true);
  expect(teammates).toHaveLength(TEAMMATE_ALL_CAP);
  expect(calls).toBeLessThan(3_000);
});
