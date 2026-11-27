// A list of every workspace stays under Convex's per-query read cap (4,096
// db calls, and 4,096 documents on this backend) at its worst: two team workspaces at the teammate cap, each
// priority's milestones naming tasks with sessions, and the viewer's own
// with links (priorityRead.ts listFor, TEAMMATE_LINKED); and with `all`,
// whose bigger cap holds across every workspace together; and many team
// workspaces, which share one teammate budget.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { TEAMMATE_ALL_CAP, TEAMMATE_LINKED, TEAMMATE_PRIORITIES_CAP, TEAMMATE_TOTAL_CAP, listFor } from "./priorityRead";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(180_000);

const NOW = Date.now();
const OWN = 30;

/**
 * ctx with a db that counts each get and each query it runs (first, take,
 * collect, unique, paginate), and every document they return: Convex caps a
 * query's reads in documents scanned as well as calls.
 */
function counting(ctx: any): { ctx: any; calls: () => number; docs: () => number } {
  let calls = 0;
  let docs = 0;
  const TERMINAL = new Set(["first", "take", "collect", "unique", "paginate"]);
  const tally = (r: any) => { docs += Array.isArray(r) ? r.length : Array.isArray(r?.page) ? r.page.length : r ? 1 : 0; return r; };
  const wrapQuery = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        const terminal = TERMINAL.has(String(prop));
        if (terminal) calls++;
        const out = v.apply(target, args);
        if (terminal) return Promise.resolve(out).then(tally);
        return out && typeof out === "object" && typeof out.then !== "function" ? wrapQuery(out) : out;
      };
    },
  });
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "get") return (...args: any[]) => (calls++, Promise.resolve(v.apply(target, args)).then(tally));
      if (prop === "query") return (...args: any[]) => wrapQuery(v.apply(target, args));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, db }, calls: () => calls, docs: () => docs };
}

/**
 * Documents a list may read: this backend refuses a query past 4,096
 * (convex org.ts F2), and the list keeps well clear of it where its caps
 * allow (DOCS_BUDGET). Two shapes sit between the two: sixteen teammates each
 * with sixty active priorities per workspace, whose groups a rank must read
 * whole to number (positionsFor), and five team workspaces at the full
 * teammate budget, whose per-row reads (sessions, tasks, group) add up.
 */
const DOCS_BUDGET = 2_500;
const DOCS_CAP = 4_096;

/**
 * Ada and Bea share `teamNames` (Acme first). Ada has `perTeam` active
 * priorities in each, ranked 1..perTeam, and one more in Acme ranked last but
 * the most recently active (`late`), with a session asking on s3; Bea has OWN
 * in Acme. `mates` more teammates share both teams too, each with
 * TEAMMATE_PRIORITIES_CAP light priorities in each (one listed session, no
 * milestones), as recently active as Ada's of the same rank.
 */
async function world(perTeam: number, teamNames = ["Acme", "Beta"], mates = 0) {
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
    for (let m = 0; m < mates; m++) {
      const mate = await ctx.db.insert("users", { name: `Mate ${m}` });
      for (const team of teams) {
        await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 });
        for (let rank = 1; rank <= TEAMMATE_PRIORITIES_CAP; rank++) {
          const p = await ctx.db.insert("priorities", {
            user_id: mate, workspace: `team:${team}`, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank, steps: [],
            first_seen_at: NOW, last_active_at: NOW - rank - (m + 1) / 100, pass_at: NOW, created_at: NOW, updated_at: NOW,
          });
          await conv(mate, team, { priority_id: p });
        }
      }
    }
    for (let rank = 1; rank <= OWN; rank++) await priority(bea, teams[0], rank);
    const late = await priority(ada, teams[0], perTeam + 1);
    await ctx.db.patch(late, { last_active_at: NOW + 10 });
    await conv(ada, teams[0], { priority_id: late, priority_step_key: "s3", thread_state_status: "blocked", thread_state_at: NOW, last_turn_at: NOW - 1000, updated_at: NOW + 1 });
    return { bea, late };
  });
  /** Bea's list of every workspace, and the db calls it made and documents they returned. */
  const listed = (args: { all?: boolean } = {}) => t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, ids.bea, args);
    return { list, calls: counted.calls(), docs: counted.docs() };
  });
  return { ...ids, listed };
}

test("a list of every workspace at the teammate cap stays well under the read cap, and a teammate's priority past the link budget still reports its mapped sessions", async () => {
  const { late, listed } = await world(TEAMMATE_PRIORITIES_CAP);
  const { list, calls, docs } = await listed();
  console.log(`priority list worst case: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
  expect(list.priorities.filter((r: any) => r.mine)).toHaveLength(OWN);
  expect(calls).toBeLessThan(3_000);
  expect(docs).toBeLessThan(DOCS_BUDGET);
  // Full `links` on the viewer's own and TEAMMATE_LINKED teammates'; the rest only `mapped_links`, never taken for full ones.
  const teammates = list.priorities.filter((r: any) => !r.mine);
  expect(teammates.filter((r: any) => r.links)).toHaveLength(TEAMMATE_LINKED);
  expect(teammates.filter((r: any) => r.mapped_links)).toHaveLength(2 * TEAMMATE_PRIORITIES_CAP - TEAMMATE_LINKED);
  expect(teammates.every((r: any) => !r.links !== !r.mapped_links)).toBe(true);

  // Full links reach a task's sessions; only TEAMMATE_LINKED teammates' priorities, every #1 first.
  const viaTask = (r: any) => (r.links ?? []).some((l: any) => l.sessions.some((s: any) => s.why.some((w: string) => w.startsWith("via "))));
  expect(teammates.filter(viaTask)).toHaveLength(TEAMMATE_LINKED);
  expect(teammates.filter((r: any) => r.rank === 1).every(viaTask)).toBe(true);
  expect(list.priorities.filter((r: any) => r.mine).every(viaTask)).toBe(true);

  // Past the budget: linked from its mapped sessions alone, the asking one on its milestone.
  const row = list.priorities.find((r: any) => String(r._id) === String(late));
  expect(row.rank).toBe(TEAMMATE_PRIORITIES_CAP + 1);
  expect([row.links, row.plan]).toEqual([undefined, undefined]);
  const s3 = row.mapped_links.find((l: any) => l.key === "s3");
  expect(s3.sessions[0]).toMatchObject({ state: "needs_you", mine: false, why: ["mapped"] });
});

test("with all, teammates' priorities are capped across every workspace together, so the bigger cap stays under the read cap", async () => {
  // Each of three workspaces holds the cap: a cap per workspace would list three times as many, past 3,000 reads.
  const { listed } = await world(TEAMMATE_ALL_CAP, ["Acme", "Beta", "Gamma"]);
  const { list, calls, docs } = await listed({ all: true });
  console.log(`priority list with all: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
  expect(docs).toBeLessThan(DOCS_BUDGET);
  const teammates = list.priorities.filter((r: any) => !r.mine);
  expect(list.teammates_truncated).toBe(true);
  expect(teammates).toHaveLength(TEAMMATE_ALL_CAP);
  expect(calls).toBeLessThan(3_000);
});

test("many teammates, each with a big active group, stay under the read cap: numbering stops at each one's last listed row", async () => {
  const { listed } = await world(TEAMMATE_PRIORITIES_CAP, ["Acme", "Beta"], 15);
  for (const args of [{}, { all: true }]) {
    const { list, calls, docs } = await listed(args);
    console.log(`priority list with 16 teammates ${JSON.stringify(args)}: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
    expect(calls).toBeLessThan(3_000);
    expect(docs).toBeLessThan(DOCS_CAP);
    // Every teammate is on the page in both workspaces.
    expect(new Set(list.priorities.filter((r: any) => !r.mine).map((r: any) => `${r.user_id} ${r.workspace}`)).size).toBe(32);
  }
});

test("many team workspaces share one teammate budget, each keeping its share, so the read cap holds as workspaces grow", async () => {
  const teams = ["Acme", "Beta", "Gamma", "Delta", "Epsilon"];
  const { listed } = await world(TEAMMATE_PRIORITIES_CAP, teams);
  const { list, calls, docs } = await listed();
  console.log(`priority list of ${teams.length} team workspaces: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
  expect(calls).toBeLessThan(3_000);
  expect(docs).toBeLessThan(DOCS_CAP);
  const teammates = list.priorities.filter((r: any) => !r.mine);
  expect(list.teammates_truncated).toBe(true);
  expect(teammates).toHaveLength(TEAMMATE_TOTAL_CAP);
  const perWorkspace = new Map<string, number>();
  for (const r of teammates) perWorkspace.set(r.workspace, (perWorkspace.get(r.workspace) ?? 0) + 1);
  expect(perWorkspace.size).toBe(teams.length);
  for (const n of perWorkspace.values()) expect(n).toBeGreaterThanOrEqual(Math.floor(TEAMMATE_TOTAL_CAP / teams.length));
  expect(list.priorities.filter((r: any) => r.mine)).toHaveLength(OWN);
});
