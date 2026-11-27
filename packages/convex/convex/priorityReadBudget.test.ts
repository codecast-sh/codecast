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
import { OWN_LINKED, TEAMMATE_ALL_CAP, TEAMMATE_LINKED, TEAMMATE_PRIORITIES_CAP, TEAMMATE_TOTAL_CAP, listFor, showFor } from "./priorityRead";
import { sessionPriorityReader } from "./lib/sessionPriority";
import { ACCESS_SESSIONS_READ, ACCESS_SESSIONS_WIDE, ACCESS_WIDEN_BUDGET } from "./lib/priorityAccess";
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
 * with sixty active priorities per workspace, and five team workspaces at the
 * full teammate budget, whose per-row reads (sessions, tasks) add up. Dense
 * shapes, many teammates each with many sessions on every priority, stay
 * under DENSE_BUDGET.
 */
const DOCS_BUDGET = 2_500;
const DOCS_CAP = 4_096;
const DENSE_BUDGET = 3_500;

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
  const shown = (id: Id<"priorities">) => t.run(async (ctx: any) => {
    const p = await ctx.db.get(id);
    return await showFor(ctx, ids.bea, p.short_id);
  });
  const listed = (args: { all?: boolean } = {}) => t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, ids.bea, args);
    return { list, calls: counted.calls(), docs: counted.docs() };
  });
  return { ...ids, listed, shown };
}

test("a list of every workspace at the teammate cap stays well under the read cap, and a teammate's priority past the link budget still reports its mapped sessions", async () => {
  const { late, listed, shown } = await world(TEAMMATE_PRIORITIES_CAP);
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
  // The list numbers Ada over the rows it judged: the cap left out her oldest (#60), so her last reads #60 here and #61 on its page.
  const row = list.priorities.find((r: any) => String(r._id) === String(late));
  expect(row.rank).toBe(TEAMMATE_PRIORITIES_CAP);
  expect(((await shown(late)) as any).rank).toBe(TEAMMATE_PRIORITIES_CAP + 1);
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

test("many teammates, each with a big active group, stay under the read cap: numbering reads nothing past the rows it lists", async () => {
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

/**
 * Bea and `mates` teammates share `teams`; each teammate has `per` active
 * priorities in each, as recently active as a seeded shuffle says, each with
 * `sessions` sessions listed to the team. Every priority judges readable, so
 * the list holds every teammate cap allows.
 */
async function dense(mates: number, per: number, sessions: number, teamNames = ["Acme", "Beta"]) {
  const t = convexTest(schema, allModules);
  const { bea, convs } = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const teams: Id<"teams">[] = [];
    for (const name of teamNames) {
      const team = await ctx.db.insert("teams", { name, created_at: NOW, features: { priorities: true } });
      await ctx.db.insert("team_memberships", { user_id: bea, team_id: team, role: "member", joined_at: 1 });
      teams.push(team);
    }
    let n = 0;
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const convs: Array<{ id: Id<"conversations">; rank: number }> = [];
    for (let m = 0; m < mates; m++) {
      const mate = await ctx.db.insert("users", { name: `Mate ${m}` });
      for (const team of teams) {
        await ctx.db.insert("team_memberships", { user_id: mate, team_id: team, role: "member", joined_at: 1 });
        for (let rank = 1; rank <= per; rank++) {
          const p = await ctx.db.insert("priorities", {
            user_id: mate, workspace: `team:${team}`, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank, steps: [],
            first_seen_at: NOW, last_active_at: NOW - Math.floor(rnd() * 1e6), pass_at: NOW, created_at: NOW, updated_at: NOW,
          });
          for (let s = 0; s < sessions; s++) {
            const sid = `jx7c${n++}`;
            const c = await ctx.db.insert("conversations", {
              user_id: mate, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
              started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p,
            });
            if (s === 0) convs.push({ id: c, rank });
          }
        }
      }
    }
    return { bea, convs };
  });
  return { t, bea, convs };
}

for (const [mates, per, sessions, teams] of [[8, 30, 10, 2], [4, 60, 10, 2], [16, 20, 6, 2], [6, 30, 10, 3]] as const) {
  test(`a dense list of every workspace (${mates} teammates x ${per} priorities x ${sessions} sessions, ${teams} workspaces) numbers its teammates with no extra reads`, async () => {
    const { t, bea } = await dense(mates, per, sessions, ["Acme", "Beta", "Gamma"].slice(0, teams));
    const { list, calls, docs } = await t.run(async (ctx: any) => {
      const counted = counting(ctx);
      const list = await listFor(counted.ctx, bea, {});
      return { list, calls: counted.calls(), docs: counted.docs() };
    });
    console.log(`dense priority list ${mates}x${per}x${sessions}, ${teams} workspaces: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
    expect(docs).toBeLessThan(DENSE_BUDGET);
    // Each teammate's listed rows are numbered 1..n in a workspace, no gap.
    const ranks = new Map<string, number[]>();
    for (const r of list.priorities as any[]) ranks.set(`${r.user_id} ${r.workspace}`, [...(ranks.get(`${r.user_id} ${r.workspace}`) ?? []), r.rank]);
    for (const got of ranks.values()) expect([...got].sort((a, b) => a - b)).toEqual(got.map((_, i) => i + 1));
  });
}

/** The documents a Deploys board reads naming the priorities of the sessions `on` picks, in one team. */
async function board(on: (rank: number) => boolean) {
  const { t, bea, convs } = await dense(8, 30, 10);
  return t.run(async (ctx: any) => {
    const team = (await ctx.db.get(convs[0].id)).team_id;
    const picked = [];
    for (const c of convs) {
      const conv = await ctx.db.get(c.id);
      if (String(conv.team_id) === String(team) && on(c.rank)) picked.push({ conv, rank: c.rank });
    }
    const counted = counting(ctx);
    const priorityOf = await sessionPriorityReader(counted.ctx, bea, team);
    const ranks: Array<number | null> = [];
    for (const { conv } of picked) ranks.push((await priorityOf(conv))?.rank ?? null);
    return { docs: counted.docs(), ranks, wanted: picked.map((p) => p.rank) };
  });
}

test("a dense Deploys board numbers each session's priority by walking its group only down to it", async () => {
  // Eight teammates' groups of thirty: the board holds each one's #3, or each one's #30.
  const shallow = await board((rank) => rank === 3);
  const deep = await board((rank) => rank === 30);
  console.log(`dense deploys board: ${shallow.docs} documents for each teammate's #3, ${deep.docs} for each one's #30`);
  expect(shallow.ranks).toEqual(shallow.wanted);
  expect(deep.ranks).toEqual(deep.wanted);
  // Three priorities judged per group, not thirty: the walk stops at the one it numbers (each group's own read of thirty is the same either way).
  expect(shallow.docs * 3).toBeLessThan(deep.docs);
  expect(deep.docs).toBeLessThan(DENSE_BUDGET);
});

/**
 * `mates` teammates in one team with `per` active priorities each; every
 * priority has `own` of its owner's sessions, then `starts` newer ones other
 * teammates started on it, which crowd the owner's out of the newest. Returns
 * the session on each teammate's last-ranked priority.
 */
async function crowded(mates: number, per: number, own: number, starts: number) {
  const t = convexTest(schema, allModules);
  const out = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } });
    const users: Id<"users">[] = [];
    for (const u of [bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
    for (let m = 0; m < mates; m++) {
      const u = await ctx.db.insert("users", { name: `Mate ${m}` });
      users.push(u);
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
    }
    let n = 0;
    const conv = (u: Id<"users">, fields: Record<string, unknown>) => {
      const sid = `jx7c${n++}`;
      return ctx.db.insert("conversations", {
        user_id: u, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      });
    };
    const deepest: Id<"conversations">[] = [];
    for (let m = 0; m < mates; m++) {
      for (let rank = 1; rank <= per; rank++) {
        const p = await ctx.db.insert("priorities", {
          user_id: users[m], workspace: `team:${team}`, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank,
          steps: [{ key: "s1", title: "M", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
          first_seen_at: NOW, last_active_at: NOW - rank * 10 - m, pass_at: NOW, created_at: NOW, updated_at: NOW,
        });
        let first: Id<"conversations"> | null = null;
        for (let s = 0; s < own; s++) {
          const c = await conv(users[m], { priority_id: p, priority_step_key: "s1" });
          first ??= c;
        }
        for (let s = 0; s < starts; s++) await conv(users[(m + 1 + (s % (mates - 1))) % mates], { priority_id: p, priority_step_key: "s1", priority_set_by: "link" });
        if (rank === per) deepest.push(first!);
      }
    }
    return { bea, team, deepest };
  });
  return t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const priorityOf = await sessionPriorityReader(counted.ctx, out.bea, out.team);
    const ranks: Array<number | null> = [];
    for (const id of out.deepest) ranks.push((await priorityOf(await ctx.db.get(id)))?.rank ?? null);
    return { ranks, docs: counted.docs() };
  });
}

for (const [mates, per, own, starts] of [[8, 30, 10, 3], [6, 30, 30, 2]] as const) {
  test(`a Deploys board over groups crowded by Starts (${mates} teammates x ${per} priorities, ${own} own sessions + ${starts} Starts each) widens a step at a time`, async () => {
    const { ranks, docs } = await crowded(mates, per, own, starts);
    console.log(`crowded deploys board ${mates}x${per}, ${own} own + ${starts} Starts: ${docs} documents for each teammate's #${per}`);
    expect(ranks).toEqual(ranks.map(() => per));
    expect(docs).toBeLessThan(DENSE_BUDGET);
  });
}

/**
 * Two team workspaces, `mates` teammates with `per` active priorities in
 * each, every priority with `own` of its owner's sessions; each teammate's
 * top `hot` also carry `starts` newer sessions other teammates started on
 * them (Starts on each other's top work), crowding the owner's out of the
 * newest. Bea's list of every workspace, and what it read.
 */
async function crowdedList(mates: number, per: number, own: number, hot: number, starts: number) {
  const t = convexTest(schema, allModules);
  const bea = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const users: Id<"users">[] = [];
    for (let m = 0; m < mates; m++) users.push(await ctx.db.insert("users", { name: `Mate ${m}` }));
    let n = 0;
    for (const name of ["Acme", "Beta"]) {
      const team = await ctx.db.insert("teams", { name, created_at: NOW, features: { priorities: true } });
      for (const u of [bea, ...users]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
      const conv = (u: Id<"users">, fields: Record<string, unknown>) => {
        const sid = `jx7c${n++}`;
        return ctx.db.insert("conversations", {
          user_id: u, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
        });
      };
      for (let m = 0; m < mates; m++) {
        for (let rank = 1; rank <= per; rank++) {
          const p = await ctx.db.insert("priorities", {
            user_id: users[m], workspace: `team:${team}`, short_id: `pri-${n++}`, title: `${m}:${rank}`, summary: "", status: "active", ai_rank: rank,
            steps: [{ key: "s1", title: "M", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
            first_seen_at: NOW, last_active_at: NOW - rank * 10 - m, pass_at: NOW, created_at: NOW, updated_at: NOW,
          });
          for (let s = 0; s < own; s++) await conv(users[m], { priority_id: p, priority_step_key: "s1" });
          if (rank <= hot) for (let s = 0; s < starts; s++) await conv(users[(m + 1 + (s % (mates - 1))) % mates], { priority_id: p, priority_step_key: "s1", priority_set_by: "link" });
        }
      }
    }
    return bea;
  });
  return t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, bea, {});
    return { list, calls: counted.calls(), docs: counted.docs() };
  });
}

/** Each teammate's top `hot` in both workspaces are on the list: Starts crowding them never hide them. */
const listsTop = (list: any, mates: number, hot: number) => {
  const titles = new Set(list.priorities.map((r: any) => `${r.workspace} ${r.title}`));
  const workspaces = new Set(list.priorities.map((r: any) => r.workspace));
  expect(workspaces.size).toBe(2);
  for (const ws of workspaces) for (let m = 0; m < mates; m++) for (let rank = 1; rank <= hot; rank++) expect(titles.has(`${ws} ${m}:${rank}`)).toBe(true);
};

for (const own of [40, 50]) {
  test(`a list where Starts crowd each teammate's top 5 (8 teammates x 30 priorities x 2 workspaces, ${own} own sessions, 7 Starts) pages its judgment in tens`, async () => {
    const { list, calls, docs } = await crowdedList(8, 30, own, 5, 7);
    console.log(`crowded priority list, ${own} own sessions + 7 Starts on each top 5: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
    expect(docs).toBeLessThan(DENSE_BUDGET);
    listsTop(list, 8, 5);
  });
}

test("a priority whose owner's sessions turn up only past the newest 40 is still read: the judgment pages to its widest window", async () => {
  // 42 Starts on each teammate's #1, then the owner's own: the 4th of them is the 46th newest.
  const { list, calls, docs } = await crowdedList(8, 30, 10, 1, 42);
  console.log(`crowded priority list, the owner's sessions past 40 on each #1: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
  expect(docs).toBeLessThan(DENSE_BUDGET);
  listsTop(list, 8, 1);
});

/**
 * Eve floods: in two team workspaces, every one of `owners` teammates' `per`
 * priorities has its owner's one session and then `starts` of Eve's Starts,
 * so each judgment pages to its widest window. Clean's five priorities in
 * each workspace have only Clean's own session, and are as recently active as
 * the flooded ones ranked 10 and 11, so the list judges them after the
 * widening budget is spent.
 */
async function flood(owners: number, per: number, starts: number) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const eve = await ctx.db.insert("users", { name: "Eve" });
    const clean = await ctx.db.insert("users", { name: "Clean" });
    const users: Id<"users">[] = [];
    for (let m = 0; m < owners; m++) users.push(await ctx.db.insert("users", { name: `Owner ${m}` }));
    let n = 0;
    let team: Id<"teams"> | null = null;
    const flooded: Id<"conversations">[] = [];
    for (const name of ["Acme", "Beta"]) {
      team = await ctx.db.insert("teams", { name, created_at: NOW, features: { priorities: true } });
      for (const u of [bea, eve, clean, ...users]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
      const conv = (u: Id<"users">, fields: Record<string, unknown>) => {
        const sid = `jx7c${n++}`;
        return ctx.db.insert("conversations", {
          user_id: u, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
          started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
        });
      };
      const priority = (owner: Id<"users">, rank: number, at: number) => ctx.db.insert("priorities", {
        user_id: owner, workspace: `team:${team}`, short_id: `pri-${n++}`, title: `${name}:${rank}`, summary: "", status: "active", ai_rank: rank,
        steps: [{ key: "s1", title: "M", tier: "critical", tier_set_by: "pass", refs: [], done: false }],
        first_seen_at: NOW, last_active_at: at, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      for (let m = 0; m < owners; m++) {
        for (let rank = 1; rank <= per; rank++) {
          const p = await priority(users[m], rank, NOW - rank * 10 - m);
          const own = await conv(users[m], { priority_id: p, priority_step_key: "s1" });
          if (name === "Beta") flooded.push(own);
          for (let s = 0; s < starts; s++) await conv(eve, { priority_id: p, priority_step_key: "s1", priority_set_by: "link" });
        }
      }
      for (let rank = 1; rank <= 5; rank++) await conv(clean, { priority_id: await priority(clean, rank, NOW - 105 - rank / 10), priority_step_key: "s1" });
    }
    return { bea, clean, team: team!, flooded };
  });
  const listed = await t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, ids.bea, {});
    return { list, calls: counted.calls(), docs: counted.docs() };
  });
  // The Deploys board over every flooded priority's session in one team: the same reader, the same budget.
  const board = await t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const priorityOf = await sessionPriorityReader(counted.ctx, ids.bea, ids.team);
    let named = 0;
    for (const id of ids.flooded) if (await priorityOf(await ctx.db.get(id))) named++;
    return { named, docs: counted.docs() };
  });
  return { ...ids, ...listed, board };
}

test("Starts stacked on every teammate's priority spend one widening budget: the list stays under the read cap and uncrowded priorities stay on it", async () => {
  const { list, calls, docs, clean, board } = await flood(3, 25, 49);
  const flooded = list.priorities.filter((r: any) => r.user_id !== String(clean));
  console.log(`flooded priority list: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows (${flooded.length} flooded); deploys board: ${board.docs} documents, ${board.named} named`);
  expect(docs).toBeLessThan(DENSE_BUDGET);
  // Clean's five in each workspace, judged after the budget ran out, need no widening.
  expect(list.priorities.filter((r: any) => r.user_id === String(clean))).toHaveLength(10);
  // Each flooded priority pages 10 to 50: the budget reads that far for 20 of them, the rest are hidden.
  expect(flooded).toHaveLength(ACCESS_WIDEN_BUDGET / (ACCESS_SESSIONS_WIDE - ACCESS_SESSIONS_READ));
  expect(board.docs).toBeLessThan(DENSE_BUDGET);
  expect(board.named).toBe(ACCESS_WIDEN_BUDGET / (ACCESS_SESSIONS_WIDE - ACCESS_SESSIONS_READ));
});

/**
 * Bea has `own` active priorities in each of `teams` team workspaces, and
 * three teammates twenty each, all heavy (four milestones naming a task with
 * two sessions, five mapped sessions): full links read each one's tasks and
 * their sessions.
 */
async function ownHeavy(teams: number, own: number) {
  const t = convexTest(schema, allModules);
  const bea = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    let n = 0;
    const conv = (owner: Id<"users">, team: Id<"teams">, fields: Record<string, unknown> = {}) => {
      const sid = `jx7c${n++}`;
      return ctx.db.insert("conversations", {
        user_id: owner, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      });
    };
    const heavy = async (owner: Id<"users">, team: Id<"teams">, rank: number) => {
      const ws = `team:${team}`;
      const steps = [];
      for (let s = 1; s <= 4; s++) {
        const short_id = `ct-${n++}`;
        await ctx.db.insert("tasks", { user_id: owner, team_id: team, workspace: ws, short_id, title: short_id, status: "open", conversation_ids: [await conv(owner, team), await conv(owner, team)], created_at: NOW, updated_at: NOW });
        steps.push({ key: `s${s}`, title: `M${s}`, tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: short_id }], done: false });
      }
      const p = await ctx.db.insert("priorities", {
        user_id: owner, workspace: ws, short_id: `pri-${n++}`, title: "p", summary: "", status: "active", ai_rank: rank, steps,
        first_seen_at: NOW, last_active_at: NOW - rank, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      for (let m = 0; m < 5; m++) await conv(owner, team, { priority_id: p, priority_step_key: `s${(m % 4) + 1}` });
    };
    const mates: Id<"users">[] = [];
    for (let m = 0; m < 3; m++) mates.push(await ctx.db.insert("users", { name: `Mate ${m}` }));
    for (let k = 0; k < teams; k++) {
      const team = await ctx.db.insert("teams", { name: `T${k}`, created_at: NOW, features: { priorities: true } });
      for (const u of [bea, ...mates]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 });
      for (let rank = 1; rank <= own; rank++) await heavy(bea, team, rank);
      for (const mate of mates) for (let rank = 1; rank <= 20; rank++) await heavy(mate, team, rank);
    }
    return bea;
  });
  return t.run(async (ctx: any) => {
    const counted = counting(ctx);
    const list = await listFor(counted.ctx, bea, {});
    return { list, calls: counted.calls(), docs: counted.docs() };
  });
}

for (const [teams, own] of [[3, 40], [2, 50]] as const) {
  test(`the viewer's own heavy priorities (${own} in each of ${teams} workspaces, beside teammates') share one link budget across workspaces`, async () => {
    const { list, calls, docs } = await ownHeavy(teams, own);
    console.log(`priority list with ${own} own heavy in ${teams} workspaces: ${calls} db calls, ${docs} documents for ${list.priorities.length} rows`);
    expect(docs).toBeLessThan(DENSE_BUDGET);
    const mine = list.priorities.filter((r: any) => r.mine);
    expect(mine).toHaveLength(teams * own);
    expect(mine.filter((r: any) => r.links)).toHaveLength(OWN_LINKED);
    expect(mine.every((r: any) => !r.links !== !r.mapped_links)).toBe(true);
  });
}

/** ctx whose db tallies the queries it starts, by table. */
function byTable(ctx: any): { ctx: any; seen: Record<string, number> } {
  const seen: Record<string, number> = {};
  const db = new Proxy(ctx.db, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "query") return (table: string, ...rest: any[]) => { seen[table] = (seen[table] ?? 0) + 1; return v.call(target, table, ...rest); };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ctx: { ...ctx, db }, seen };
}

test("whether a closed session shipped is asked only by show, one indexed read each: the viewer's heavy list of closed, landed sessions reads no commits", async () => {
  const t = convexTest(schema, allModules);
  const { bea, first } = await t.run(async (ctx: any) => {
    const bea = await ctx.db.insert("users", { name: "Bea" });
    const team = await ctx.db.insert("teams", { name: "T", created_at: NOW, features: { priorities: true } });
    await ctx.db.insert("team_memberships", { user_id: bea, team_id: team, role: "member", joined_at: 1 });
    const ws = `team:${team}`;
    let n = 0;
    // Every session closed, each with two commits on main.
    const conv = async (fields: Record<string, unknown> = {}) => {
      const sid = `jx7c${n++}`;
      const c = await ctx.db.insert("conversations", {
        user_id: bea, team_id: team, agent_type: "claude_code", session_id: sid, short_id: sid, title: sid, inbox_killed_at: NOW,
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", ...fields,
      });
      for (const k of [0, 1]) await ctx.db.insert("commits", { conversation_id: c, sha: `${sid}-${k}`, message: "m", author_name: "B", author_email: "b@x", timestamp: NOW, files_changed: 1, insertions: 1, deletions: 0, repository: "o/r", main_at: NOW - k });
      return c;
    };
    let first = "";
    for (let rank = 1; rank <= OWN_LINKED + 10; rank++) {
      const steps = [];
      for (let s = 1; s <= 4; s++) {
        const short_id = `ct-${n++}`;
        await ctx.db.insert("tasks", { user_id: bea, team_id: team, workspace: ws, short_id, title: short_id, status: "open", conversation_ids: [await conv(), await conv()], created_at: NOW, updated_at: NOW });
        steps.push({ key: `s${s}`, title: `M${s}`, tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: short_id }], done: false });
      }
      const short_id = `pri-${n++}`;
      const p = await ctx.db.insert("priorities", {
        user_id: bea, workspace: ws, short_id, title: "p", summary: "", status: "active", ai_rank: rank, steps,
        first_seen_at: NOW, last_active_at: NOW - rank, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      for (let m = 0; m < 5; m++) await conv({ priority_id: p, priority_step_key: `s${(m % 4) + 1}` });
      if (rank === 1) first = short_id;
    }
    return { bea, first };
  });
  const listed = await t.run(async (ctx: any) => {
    const tables = byTable(ctx);
    const counted = counting(tables.ctx);
    const list = await listFor(counted.ctx, bea, {});
    return { list, calls: counted.calls(), seen: tables.seen };
  });
  console.log(`priority list of ${OWN_LINKED + 10} heavy priorities, every session closed and landed: ${listed.calls} db calls`);
  expect(listed.list.priorities.filter((r: any) => r.links)).toHaveLength(OWN_LINKED);
  expect(listed.seen.commits ?? 0).toBe(0);
  expect(listed.calls).toBeLessThan(DOCS_CAP);
  const shown = await t.run(async (ctx: any) => {
    const tables = byTable(ctx);
    const show: any = await showFor(tables.ctx, bea, first);
    return { show, seen: tables.seen };
  });
  const closed = new Set(shown.show.links.flatMap((l: any) => l.sessions.map((s: any) => s.conversation_id)));
  // One read per closed session it sends, and every one of them landed.
  expect(shown.seen.commits).toBe(closed.size);
  expect(new Set(shown.show.shipped_sessions)).toEqual(closed);
});

test("the viewer's own full links go round the workspaces by rank: every workspace's #1, then each #2, and so on", async () => {
  const { list } = await ownHeavy(3, 40);
  const mine = list.priorities.filter((r: any) => r.mine);
  const full = mine.filter((r: any) => r.links);
  // 40 over 3 workspaces: #1..#13 in each, and one #14.
  const deepest = Math.ceil(OWN_LINKED / 3);
  for (const ws of new Set(mine.map((r: any) => r.workspace))) {
    const ranks = full.filter((r: any) => r.workspace === ws).map((r: any) => r.rank).sort((a: number, b: number) => a - b);
    expect(ranks.slice(0, deepest - 1)).toEqual(Array.from({ length: deepest - 1 }, (_, i) => i + 1));
  }
  expect(Math.max(...full.map((r: any) => r.rank))).toBe(deepest);
  expect(full.filter((r: any) => r.rank === deepest)).toHaveLength(OWN_LINKED - 3 * (deepest - 1));
});
