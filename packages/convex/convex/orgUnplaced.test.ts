import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { budgetedReads, planDriverRefs, readUnplaced, UNPLACED_READ } from "./orgUnplaced";

// The unplaced reading (ct-95900) read as one member of a team: it names only
// what that member may read, and it stays inside one query's read budget.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 3_600_000;
const D = 24 * H;

const conv = (id: string, user: string, isPrivate: boolean, over: Record<string, unknown> = {}) => ({
  _id: id, user_id: user, team_id: TEAM, is_private: isPrivate, status: "active", agent_type: "claude",
  title: `${isPrivate ? "PRIVATE" : "Shared"} session ${id}`, short_id: id.replace("conversations_", "jx"), session_id: id,
  started_at: NOW - 10 * D, created_at: NOW - 10 * D, updated_at: NOW - H, message_count: 3, ...over,
});

function world(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    org_roles: [], anchors: [], initiatives: [], projects: [], managed_sessions: [], session_owners: [], user_presence: [], bucket_assignments: [], inbox_buckets: [],
    plans: [], tasks: [], conversations: [],
    ...extra,
  });
}
const ctxOf = (db: any) => ({ db }) as any;

describe("unplaced names only what the caller may read (review findings 1 and 2)", () => {
  // Mate works from a private session: it drives a team plan with no project
  // and filed a loose team task. Mate's shared session, running for ten days,
  // is bound to Mate's private task and plan.
  const db = () => world({
    conversations: [
      conv("conversations_priv", MATE, true),
      conv("conversations_shared", MATE, false, { active_task_id: "tasks_private", active_plan_id: "plans_private" }),
    ],
    plans: [
      { _id: "plans_team", user_id: MATE, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Team plan", status: "active", created_at: NOW - 3 * D, updated_at: NOW - H, current_session_id: "conversations_priv", progress: { total: 1, done: 0, in_progress: 0, open: 1 } },
      { _id: "plans_private", user_id: MATE, team_id: TEAM, workspace: `user:${MATE}`, short_id: "pl-2", title: "PRIVATE plan", status: "active", created_at: NOW - 3 * D, updated_at: NOW - H },
    ],
    tasks: [
      { _id: "tasks_t1", user_id: MATE, team_id: TEAM, workspace: WS, plan_id: "plans_team", short_id: "ct-1", source: "human", title: "Team step", status: "open", created_from_conversation: "conversations_priv", created_at: NOW - D, updated_at: NOW - H },
      { _id: "tasks_loose", user_id: MATE, team_id: TEAM, workspace: WS, short_id: "ct-2", source: "human", title: "Loose team task", status: "open", created_from_conversation: "conversations_priv", created_at: NOW - D, updated_at: NOW - H },
      { _id: "tasks_private", user_id: MATE, team_id: TEAM, workspace: `user:${MATE}`, short_id: "ct-3", source: "human", title: "PRIVATE task", status: "in_progress", created_at: NOW - D, updated_at: NOW - H },
    ],
  });

  test("a teammate's private session, task and plan never appear in my reading", async () => {
    const u = await readUnplaced(ctxOf(db()), ME as any, TEAM, NOW);
    const text = JSON.stringify(u);
    expect(text).not.toContain("PRIVATE");
    // The team plan and the loose task are still listed, with no driving session named.
    expect(u.plans.map((p) => [p.short_id, p.open_tasks, p.driver])).toEqual([["pl-1", 1, null]]);
    expect(u.loose_tasks.by_session.map((g) => [g.session, g.tasks])).toEqual([[null, 1]]);
    // The shared session is bound only to records I cannot read, so it names nothing.
    expect(u.sessions).toEqual([]);
  });

  test("the owner reads their own private session, task and plan", async () => {
    const u = await readUnplaced(ctxOf(db()), MATE as any, TEAM, NOW);
    expect(u.plans[0].driver?.title).toBe("PRIVATE session conversations_priv");
    expect(u.sessions.map((s) => s.bound.map((b) => b.title))).toEqual([["PRIVATE task", "PRIVATE plan"]]);
  });

  test("a goal's open plans name a driver only when the caller may read it", async () => {
    const plans = [{ _id: "plans_x", short_id: "pl-9", title: "Carried", status: "active", project_id: "projects_p", updated_at: NOW, current_session_id: "conversations_priv" }];
    const goals = [{ status: "active", project_ids: ["projects_p"] }];
    expect((await planDriverRefs(ctxOf(db()), ME as any, plans, goals)).get("plans_x")).toBeNull();
    expect((await planDriverRefs(ctxOf(db()), MATE as any, plans, goals)).get("plans_x")?.short_id).toBe("jxpriv");
  });
});

describe("one query's read budget (review finding 4)", () => {
  test("a reading of a workspace far larger than Union stays inside the budget and says it is a floor", async () => {
    const plans = Array.from({ length: 400 }, (_, i) => ({ _id: `plans_${i}`, user_id: ME, team_id: TEAM, workspace: WS, short_id: `pl-${i}`, title: `Plan ${i}`, status: "active", created_at: NOW - D, updated_at: NOW - i * 1000, progress: { total: 50, done: 0, in_progress: 0, open: 50 } }));
    const tasks = plans.flatMap((p, i) => Array.from({ length: 50 }, (_, j) => ({ _id: `tasks_${i}_${j}`, user_id: ME, team_id: TEAM, workspace: WS, plan_id: p._id, short_id: `ct-${i}-${j}`, source: "human", title: "t", status: "open", created_at: NOW - D, updated_at: NOW - H })));
    const db = world({ plans, tasks });
    let reads = 0;
    const counted = {
      get: async (id: any) => { reads++; return db.get(id); },
      query: (table: string) => {
        const q: any = db.query(table);
        const wrap = (inner: any): any => new Proxy(inner, { get(t, k) {
          const f = t[k];
          if (k === "take") return async (n: number) => { const rows = await f.call(t, n); reads += rows.length; return rows; };
          if (k === "collect") return async () => { const rows = await f.call(t); reads += rows.length; return rows; };
          return typeof f === "function" ? (...a: any[]) => { const r = f.apply(t, a); return r && typeof r === "object" && "take" in r ? wrap(r) : r; } : f;
        } });
        return wrap(q);
      },
      normalizeId: (_t: string, id: string) => id,
    };
    const u = await readUnplaced({ db: counted } as any, ME as any, TEAM, NOW);
    expect(reads).toBeLessThanOrEqual(UNPLACED_READ.budget + 200);
    expect(u.truncated).toBe(true);
    expect(u.plans.length).toBeGreaterThan(0);
  });

  test("budgetedReads stops at the budget and marks the reading a floor", async () => {
    const db = world({ tasks: Array.from({ length: 30 }, (_, i) => ({ _id: `tasks_${i}`, workspace: WS, status: "open", updated_at: NOW })) });
    const reads = budgetedReads(ctxOf(db), 10);
    expect((await reads.take(db.query("tasks"), 25)).length).toBe(10);
    expect(reads.truncated).toBe(true);
    expect(await reads.take(db.query("tasks"), 5)).toEqual([]);
    expect(await reads.get("tasks_1")).toBeNull();
  });
});
