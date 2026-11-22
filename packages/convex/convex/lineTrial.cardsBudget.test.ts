// ct-73205: the /flows?graph=line page's lineTrial.cards feeder timed out in
// prod ("Function execution timed out (maximum duration: 3s)", eg-876, 35
// reports). One call reads the 300 newest cards plus up to 1000 waiting ones
// and builds each card with dozens of reads of its own, so the call's work
// grows with every card a workspace keeps. This drives the real query under
// convex-test on a workspace with a realistic backlog and counts the documents
// the one call reads: the page must stay under a fixed budget, whatever the
// backlog.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { CARDS_CAP, cards } from "./lineTrial";

setDefaultTimeout(300_000);

/** Wraps ctx.db so every document a read hands back is counted. */
function countingDb(db: any, counter: { reads: number; calls: number }) {
  const countResult = (r: any) => {
    if (Array.isArray(r)) counter.reads += r.length;
    else if (r && typeof r === "object" && Array.isArray(r.page)) counter.reads += r.page.length;
    else if (r) counter.reads += 1;
    return r;
  };
  const wrapQuery = (q: any): any =>
    new Proxy(q, {
      get(target, prop) {
        const value = target[prop];
        if (prop === Symbol.asyncIterator) {
          return function () {
            const it = value.call(target);
            return { next: async () => { const n = await it.next(); if (!n.done) counter.reads += 1; return n; }, [Symbol.asyncIterator]() { return this; } };
          };
        }
        if (typeof value !== "function") return value;
        return (...a: any[]) => {
          const out = value.apply(target, a);
          if (out && typeof out.then === "function") { counter.calls += 1; return out.then(countResult); }
          return out && typeof out === "object" ? wrapQuery(out) : out;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      const value = target[prop];
      if (prop === "get") return async (...a: any[]) => { counter.calls += 1; return countResult(await value.apply(target, a)); };
      if (prop === "query") return (...a: any[]) => wrapQuery(value.apply(target, a));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const NOW = 1_800_000_000_000;
const RECENT = 500;
const WAITING = 1000;
const FINDINGS_PER_PROBLEM = 12;
/** Documents one call may read. Convex caps a query at 3s; at this backlog the page has to fit well inside it. */
const READ_BUDGET = 8_000;

async function seedBacklog() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@x.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
    const workspace = `team:${team}`;
    const project = await ctx.db.insert("projects", { title: "Product", user_id: owner, team_id: team, workspace, status: "active", line_trial: { since: 1, by: owner }, created_at: 1, updated_at: 1 } as any);
    const workflow = await ctx.db.insert("workflows", { user_id: owner, name: "codecast_fix", nodes: [{ id: "build" }, { id: "card" }], edges: [], created_at: 1, updated_at: 1 } as any);
    let sig = 0;
    for (let i = 0; i < RECENT + WAITING; i++) {
      // The older cards wait; the newest RECENT were answered, so the recent window holds none of the waiting ones.
      const waiting = i < WAITING;
      const at = NOW - (RECENT + WAITING - i) * 60_000;
      const task = await ctx.db.insert("tasks", { short_id: `ct-${i}`, user_id: owner, team_id: team, workspace, project_id: project, title: `Problem ${i}`, status: "in_progress", task_type: "bug", priority: "medium", created_at: at, updated_at: at } as any);
      const station = await ctx.db.insert("conversations", { user_id: owner, team_id: team, session_id: `sess-${i}`, short_id: `jx${i}`, project_path: `/repo/.codecast/worktrees/fix-${i}`, started_at: at, updated_at: at, message_count: 3, status: "active", agent_type: "claude_code" } as any);
      const run = await ctx.db.insert("workflow_runs", {
        user_id: owner, task_id: task, workflow_id: workflow, status: "paused", gate_node_id: "card", project_path: "/repo", workspace, team_id: team,
        node_statuses: [{ node_id: "build", status: "completed", session_id: `sess-${i}`, started_at: at - 1000, completed_at: at }, { node_id: "card", status: "paused" }],
        created_at: at, updated_at: at,
      } as any);
      const seen = [] as Array<{ signal: string }>;
      for (let f = 0; f < FINDINGS_PER_PROBLEM; f++) {
        const short_id = `sg-${++sig}`;
        if (f < 3) seen.push({ signal: short_id });
        await ctx.db.insert("signals", { user_id: owner, workspace, short_id, source: "sdk", kind: "bug", fingerprint: `fp-${sig}`, title: `Finding ${sig}`, observed_at: at, created_at: at, attach: "fingerprint", task_id: task } as any);
      }
      await ctx.db.insert("trial_cards", {
        workspace, team_id: team, project_id: project, task_id: task, run_id: run, short_id: `tc-${i}`, node_id: "card", kind: "card",
        status: waiting ? "waiting" : "answered", ...(waiting ? {} : { answer: { key: "S", label: "Ship", at, by: owner } }), question: "Ship this fix?", options: [{ key: "S", label: "Ship" }, { key: "D", label: "Drop" }],
        card: { v: 1, headline: `Fix ${i}`, seen, reach: { read: true } }, created_at: at, updated_at: at,
      } as any);
    }
    return { owner, team };
  });
  return { t, ...ids };
}

describe("lineTrial.cards (ct-73205: the line page's feeder timed out at 3s)", () => {
  test(`one call over a workspace with ${RECENT} recent and ${WAITING} waiting cards reads at most ${READ_BUDGET} documents`, async () => {
    const { t, owner, team } = await seedBacklog();
    const counter = { reads: 0, calls: 0 };
    const out = await t.run(async (ctx) => {
      const counted = { ...ctx, db: countingDb(ctx.db, counter) };
      return (cards as any)._handler(counted, { user_id: owner, workspace: "team", team_id: team });
    });
    // Capped explicitly: the cards it owes come first, newest first, and the oldest waiting ones are left out.
    expect(out.length).toBe(CARDS_CAP);
    expect(out.every((c: any) => c.status === "waiting")).toBe(true);
    expect(out.map((c: any) => c.short_id)).toEqual(Array.from({ length: CARDS_CAP }, (_, k) => `tc-${WAITING - 1 - k}`));
    console.log(`lineTrial.cards: ${out.length} cards, ${counter.reads} documents read in ${counter.calls} calls (${(counter.reads / Math.max(1, out.length)).toFixed(1)} per card)`);
    expect(counter.reads).toBeLessThanOrEqual(READ_BUDGET);
  });

  test("a card whose rows were deleted or are malformed is rendered with fallbacks or left out, never fails the list", async () => {
    const t = convexTest(schema, allModules);
    const { owner, team } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@x.dev" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
      await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
      const workspace = `team:${team}`;
      const project = await ctx.db.insert("projects", { title: "Product", user_id: owner, team_id: team, workspace, status: "active", line_trial: { since: 1, by: owner }, created_at: 1, updated_at: 1 } as any);
      const workflow = await ctx.db.insert("workflows", { user_id: owner, name: "codecast_fix", nodes: [{ id: "card" }], edges: [], created_at: 1, updated_at: 1 } as any);
      const card = async (i: number, extra: Record<string, unknown>, drop: { task?: boolean; run?: boolean } = {}) => {
        const task = await ctx.db.insert("tasks", { short_id: `ct-${i}`, user_id: owner, team_id: team, workspace, project_id: project, title: `Problem ${i}`, status: "in_progress", task_type: "bug", priority: "medium", created_at: i, updated_at: i } as any);
        const run = await ctx.db.insert("workflow_runs", { user_id: owner, task_id: task, workflow_id: workflow, status: "paused", gate_node_id: "card", project_path: "/repo", workspace, team_id: team, node_statuses: [], created_at: i, updated_at: i } as any);
        await ctx.db.insert("trial_cards", { workspace, team_id: team, project_id: project, task_id: task, run_id: run, short_id: `tc-${i}`, node_id: "card", kind: "card", status: "waiting", question: "Ship?", options: [], created_at: i, updated_at: i, ...extra } as any);
        if (drop.task) await ctx.db.delete(task);
        if (drop.run) await ctx.db.delete(run);
      };
      await card(1, { card: { v: 1, headline: "Fine", seen: [{ signal: "sg-gone" }] } });
      await card(2, { card: { v: 1, headline: "Orphan", seen: [] } }, { task: true, run: true });
      await card(3, { card: { v: 1, headline: "Malformed", seen: "not a list" } });
      return { owner, team };
    });
    const out = await t.run((ctx) => (cards as any)._handler(ctx, { user_id: owner, workspace: "team", team_id: team }));
    const byId = new Map(out.map((c: any) => [c.short_id, c]));
    expect((byId.get("tc-1") as any)?.cited).toEqual([{ signal: "sg-gone", state: "missing" }]);
    expect((byId.get("tc-2") as any)?.run_status).toBe("gone");
    expect(byId.has("tc-3")).toBe(false);
  });
  test(`a quiet project's waiting card older than the workspace's ${CARDS_CAP} newest waiting ones still answers a lookup by that project`, async () => {
    const t = convexTest(schema, allModules);
    const { owner, team, quiet } = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@x.dev" } as any);
      const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
      await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1 } as any);
      const workspace = `team:${team}`;
      const project = (title: string) => ctx.db.insert("projects", { title, user_id: owner, team_id: team, workspace, status: "active", line_trial: { since: 1, by: owner }, created_at: 1, updated_at: 1 } as any);
      const busy = await project("Busy");
      const quiet = await project("Quiet");
      const workflow = await ctx.db.insert("workflows", { user_id: owner, name: "codecast_fix", nodes: [{ id: "card" }], edges: [], created_at: 1, updated_at: 1 } as any);
      const card = async (project_id: any, i: number) => {
        const task = await ctx.db.insert("tasks", { short_id: `ct-${i}`, user_id: owner, team_id: team, workspace, project_id, title: `Problem ${i}`, status: "in_progress", task_type: "bug", priority: "medium", created_at: i, updated_at: i } as any);
        const run = await ctx.db.insert("workflow_runs", { user_id: owner, task_id: task, workflow_id: workflow, status: "paused", gate_node_id: "card", project_path: "/repo", workspace, team_id: team, node_statuses: [], created_at: i, updated_at: i } as any);
        await ctx.db.insert("trial_cards", { workspace, team_id: team, project_id, task_id: task, run_id: run, short_id: `tc-${i}`, node_id: "card", kind: "card", status: "waiting", question: "Ship?", options: [], created_at: i, updated_at: i } as any);
      };
      await card(quiet, 0);
      for (let i = 1; i <= CARDS_CAP + 10; i++) await card(busy, i);
      return { owner, team, quiet };
    });
    const out = await t.run((ctx) => (cards as any)._handler(ctx, { user_id: owner, workspace: "team", team_id: team, project: String(quiet) }));
    expect(out.map((c: any) => c.short_id)).toEqual(["tc-0"]);
  });
});
