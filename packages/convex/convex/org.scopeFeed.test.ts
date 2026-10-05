// The scope feed's line rows (docs/architecture/the-line.md L10): run rows
// for the scope's tasks and plans, pages attached to a task in scope (L6)
// merged with the session sourced pages, and open decisions asked by a
// session in scope that name no task.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { computeScopeFeed, resolveScope } from "./org";

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;

const P = "projects_p";
const PLAN = "plans_pl1";
const T1 = "tasks_t1";
const T2 = "tasks_t2";
const S1 = "conversations_s1";
const SPAWNER = "conversations_spawner";
const WF = "workflows_line";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW - 10 * H },
    ],
    plans: [
      { _id: PLAN, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Launch", status: "active", created_at: 1, updated_at: NOW - 9 * H },
    ],
    tasks: [
      { _id: T1, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", title: "Landing page", task_type: "task", status: "in_review", priority: "high", created_at: 1, updated_at: NOW - 8 * H },
      { _id: T2, user_id: ME, team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-2", title: "Analytics", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - 8.5 * H },
    ],
    docs: [],
    conversations: [
      // In scope through the task it is bound to (S35: a folder decides
      // nothing); asks a decision that names no task.
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth session", short_id: "jx1", project_path: "/repo/growth", active_task_id: T1, updated_at: NOW - 7 * H, created_at: 1, message_count: 3 },
      // Out of scope; it started the run, so it names the run's actor.
      { _id: SPAWNER, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth lead standing", short_id: "jx9", project_path: "/elsewhere", updated_at: NOW - 30 * H, created_at: 1, message_count: 3 },
    ],
    workflows: [
      { _id: WF, user_id: ME, name: "line", slug: "line", nodes: [{ id: "analyze", label: "Analyze", shape: "box", type: "agent" }, { id: "review", label: "Review", shape: "box", type: "agent" }], edges: [], created_at: 1, updated_at: 1 },
    ],
    workflow_runs: [
      // Bound to a task in scope; the stored graph names its node.
      { _id: "workflow_runs_r1", user_id: ME, workspace: WS, workflow_id: WF, task_id: T1, status: "running", current_node_id: "review", node_statuses: [{ node_id: "review", status: "running", activity: "reading the diff" }], spawner_conversation_id: SPAWNER, created_at: 1, updated_at: NOW - 1 * H },
      // Bound to a plan in scope; a dynamic run carries its own node label.
      { _id: "workflow_runs_r2", user_id: ME, workspace: WS, plan_id: PLAN, status: "paused", current_node_id: "n2", node_statuses: [{ node_id: "n2", status: "running", label: "Ship?" }], gate_prompt: "Ship it now?", workflow_name: "Launch chain", created_at: 1, updated_at: NOW - 2 * H },
      // Bound to a task outside the scope: never shown.
      { _id: "workflow_runs_r3", user_id: ME, workspace: WS, task_id: "tasks_other", status: "completed", node_statuses: [], created_at: 1, updated_at: NOW },
    ],
    session_decisions: [
      // Asked by a session in scope, no task: shown while pending.
      { _id: "sd_free", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-1", question: "Blue or green?", options: [{ label: "Blue" }, { label: "Green" }], blocking: true, status: "pending", created_at: NOW - 3 * H },
      // Same session, no task, already answered: not a feed row.
      { _id: "sd_done", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-2", question: "Old?", options: [{ label: "A" }], blocking: true, status: "answered", answer_index: 0, created_at: NOW - 12 * H, resolved_at: NOW - 11 * H },
      // On a task in scope, answered: shown through the task, as before.
      { _id: "sd_task", conversation_id: SPAWNER, session_id: "s9", user_id: ME, short_id: "sd-3", question: "Approve?", options: [{ label: "Yes" }], blocking: true, status: "answered", answer_index: 0, task_id: T1, created_at: NOW - 5 * H, resolved_at: NOW - 4 * H },
    ],
    artifacts: [
      // Published by the session in scope AND attached to ct-1: one row.
      { _id: "art_both", slug: "both", user_id: ME, title: "Report", storage_id: "st1", size: 1, version: 2, kind: "html", session_short_id: "jx1", session_conversation_id: S1, task_id: T1, station: "in_review", created_at: 1, updated_at: NOW - 6 * H },
      // Attached to ct-2 from a session outside the scope: in through the task.
      { _id: "art_task", slug: "bytask", user_id: ME, title: "Analytics plan", storage_id: "st2", size: 1, version: 1, kind: "markdown", session_short_id: "jx9", session_conversation_id: SPAWNER, task_id: T2, station: "open", created_at: 1, updated_at: NOW - 6.5 * H },
      // Neither: out.
      { _id: "art_out", slug: "out", user_id: ME, title: "Elsewhere", storage_id: "st3", size: 1, version: 1, kind: "html", session_conversation_id: SPAWNER, created_at: 1, updated_at: NOW },
    ],
    project_updates: [],
    commits: [],
    conversation_images: [],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    org_roles: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: String(ME) }) } }) as any;

async function scoped(db: any) {
  return (await resolveScope(ctxOf(db), ME as any, { scope: { project_ids: [P as any], plan_ids: [] }, team_id: TEAM }))!;
}

describe("L10 scope feed run rows", () => {
  test("runs bound to the scope's tasks and plans are rows: status plus node label, the spawner as actor, the run page as href", async () => {
    const db = fixtures();
    const resolved = await scoped(db);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["run"] });
    expect(rows.map((r) => r.id)).toEqual(["workflow_runs_r1", "workflow_runs_r2"]);
    // The short id names the task or plan the run belongs to, so the CLI's
    // feed printer shows which work a run is about.
    expect(rows[0]).toMatchObject({
      kind: "run", short_id: "ct-1", title: "line", state: "running · Review", href: "/workflows/runs/workflow_runs_r1",
      actor: { name: "Growth lead standing", is_bot: true }, preview: "reading the diff",
    });
    expect(rows[1]).toMatchObject({ kind: "run", short_id: "pl-1", title: "Launch chain", state: "paused · Ship?", preview: "Ship it now?", actor: { name: "Me" } });
  });

  test("run rows merge by updated_at with the other kinds, and the kind filter keeps them out when not asked", async () => {
    const db = fixtures();
    const resolved = await scoped(db);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW });
    expect(rows.map((r) => `${r.kind}:${r.short_id ?? r.id}`)).toEqual([
      "run:ct-1", // -1h, the run on ct-1
      "run:pl-1", // -2h, the run on pl-1
      "decision:sd-1", // -3h, pending, no task, session in scope
      "decision:sd-3", // -4h, on ct-1
      "artifact:both", // -6h, one row for a page both published in and attached inside the scope
      "artifact:bytask", // -6.5h, attached to ct-2
      "session:jx1", // -7h
      "task:ct-1",
      "task:ct-2",
      "plan:pl-1",
    ]);
    expect(rows.some((r) => r.id === "workflow_runs_r3" || r.short_id === "out" || r.short_id === "sd-2")).toBe(false);
    const without = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["task", "decision"] });
    expect(without.rows.map((r) => r.kind)).toEqual(["decision", "decision", "task", "task"]);
  });
});

describe("L6 scope feed pages attached to a task", () => {
  test("a page attached to a task in scope is a row that names the task and station; a page in through both paths is one row", async () => {
    const db = fixtures();
    const resolved = await scoped(db);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["artifact"] });
    expect(rows.map((r) => r.short_id)).toEqual(["both", "bytask"]);
    expect(rows[0]).toMatchObject({ href: "/a/both", preview: "published by jx1 · v2 · ct-1 at in_review" });
    expect(rows[1]).toMatchObject({ href: "/a/bytask", state: "markdown", preview: "published by jx9 · v1 · ct-2 at open" });
  });
});

// The read budget (org.ts computeScopeFeed): the feed's own reads must not
// grow with the number of tasks in scope. Counted on the fake db: every row a
// query hands back and every get, which is what the backend's per query
// document limit counts. resolveScope reads the tasks themselves and is
// measured apart, so the feed is judged on what it adds.
// `reads(table)` is the documents one table's queries handed back, and
// `queried` every table a query was opened on.
function countingDb(db: any): { db: any; reads: (table?: string) => number; queried: Set<string> } {
  let n = 0;
  const byTable = new Map<string, number>();
  const queried = new Set<string>();
  const count = (table?: string) => (rows: any) => {
    const got = Array.isArray(rows) ? rows.length : rows ? 1 : 0;
    n += got;
    if (table) byTable.set(table, (byTable.get(table) ?? 0) + got);
    return rows;
  };
  const wrapBuilder = (b: any, table: string): any => new Proxy(b, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        const r = v.apply(target, args);
        if (key === "collect" || key === "take" || key === "first" || key === "unique") return r.then(count(table));
        return r === target ? wrapBuilder(r, table) : r;
      };
    },
  });
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === "query") return (table: string) => { queried.add(table); return wrapBuilder(target.query(table), table); };
      if (key === "get") return (id: any) => target.get(id).then(count());
      return target[key];
    },
  });
  return { db: counting, reads: (table) => (table ? byTable.get(table) ?? 0 : n), queried };
}

describe("F2 read budget", () => {
  test("the feed's reads do not grow with the tasks in scope", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({
      _id: `tasks_bulk${i}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: `ct-${i + 10}`, title: `Task ${i}`, task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - (20 + i) * H,
    }));
    const small = countingDb(fixtures());
    const large = countingDb(fixtures({ tasks: [...fixtures()._tables.tasks, ...many] }));
    const feedReads = async (c: { db: any; reads: () => number }) => {
      const resolved = await scoped(c.db);
      const before = c.reads();
      const { rows } = await computeScopeFeed(ctxOf(c.db), resolved, { now: NOW });
      return { reads: c.reads() - before, rows };
    };
    const a = await feedReads(small);
    const b = await feedReads(large);
    expect(b.rows.length).toBe(40);
    expect(b.reads).toBe(a.reads);
    expect(a.reads).toBeLessThan(200);
  });
});

// Goals in a scope (initiatives-projects-role-page.md I5). The record's
// moments are read off the goal row, and calls from one window per team, so
// neither grows the feed's reads with the entries on the record.
describe("I5 goals in the feed", () => {
  const G = "initiatives_g1";
  const goal = (fields: Record<string, any> = {}) => ({
    _id: G, user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-1", title: "Broker launch", status: "active", project_ids: [], health: "none", created_at: 1, updated_at: NOW, ...fields,
  });
  const call = (i: number) => ({
    _id: `transcripts_c${String(i).padStart(2, "0")}`, short_id: `cl-${i}`, room_key: "channel:chat_channels_1", team_id: TEAM, started_by: ME, status: "ended", started_at: NOW - (i + 1) * H, title: `Sync ${i}`, summary: "Where in-1 stands.", participants: [{ id: ME, name: "Me" }], routes: [], last_seq: 3,
  });
  // Calls are stored oldest first: the fake db answers order("desc") on a
  // table with no stamp it knows by reversing the stored order, so this is
  // what makes it hand back the newest calls first, as by_team_started does.
  const goalFixtures = (initiative: any, calls: any[] = [], extra: Record<string, any[]> = {}) => fixtures({
    teams: [{ _id: TEAM, name: "Acme", features: { calls: true } }],
    initiatives: [initiative],
    initiative_updates: [],
    transcripts: [...calls].sort((a, b) => a.started_at - b.started_at),
    ...extra,
  });
  /** Every page of the feed, in the order the client appends them. */
  const allPages = async (db: any, resolved: any, opts: { kinds?: any[]; limit?: number } = {}) => {
    const pages: any[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, ...opts, cursor });
      pages.push(page.rows);
      if (!page.next_cursor) return pages;
      cursor = page.next_cursor;
    }
    throw new Error("the feed never ended");
  };
  const inFeedOrder = (rows: any[]) => [...rows].sort((a, b) => b.updated_at - a.updated_at || (a.id < b.id ? 1 : -1));
  const goalScope = async (db: any) => (await resolveScope(ctxOf(db), ME as any, { scope: { project_ids: [], plan_ids: [], initiative_ids: ["in-1"] }, team_id: TEAM }))!;

  test("the feed's reads do not grow with the entries on a goal's record", async () => {
    const full = goal({
      milestones: Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, title: `Milestone ${i}`, done_at: NOW - (i + 1) * H })),
      questions: Array.from({ length: 20 }, (_, i) => ({ key: `q${i}`, text: `Question ${i}`, at: NOW - (i + 30) * H })),
      decisions: Array.from({ length: 40 }, (_, i) => ({ key: `d${i}`, text: `Decision ${i}`, at: NOW - (i + 60) * H, source: { kind: "call", ref: `cl-${900 + i}` } })),
    });
    const feedReads = async (initiative: any) => {
      const c = countingDb(goalFixtures(initiative, [call(1)]));
      const resolved = await goalScope(c.db);
      const before = c.reads();
      const { rows } = await computeScopeFeed(ctxOf(c.db), resolved, { now: NOW, limit: 200 });
      return { reads: c.reads() - before, rows };
    };
    const a = await feedReads(goal({ milestones: [{ key: "m0", title: "Milestone 0", done_at: NOW - H }] }));
    const b = await feedReads(full);
    expect(a.rows.filter((r) => r.kind === "goal").length).toBe(1);
    expect(b.rows.filter((r) => r.kind === "goal").length).toBe(72);
    expect(b.reads).toBe(a.reads);
  });

  test("calls are kept a few a page, and the cursor reaches the rest", async () => {
    const db = goalFixtures(goal(), Array.from({ length: 11 }, (_, i) => call(i)));
    const resolved = await goalScope(db);
    const first = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["call"] });
    expect(first.rows.map((r) => r.short_id)).toEqual(["cl-0", "cl-1", "cl-2", "cl-3", "cl-4", "cl-5", "cl-6", "cl-7"]);
    expect(first.next_cursor).toBeDefined();
    const second = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["call"], cursor: first.next_cursor });
    expect(second.rows.map((r) => r.short_id)).toEqual(["cl-8", "cl-9", "cl-10"]);
    expect(second.next_cursor).toBeUndefined();
  });

  test("a call behind more newer team calls than one window holds is still reached", async () => {
    const quiet = Array.from({ length: 70 }, (_, i) => ({ ...call(i), summary: "Nothing about the goal." }));
    const buried = [
      { ...call(80), summary: "Where in-1 stands." },
      { ...call(81), title: "Broker launch review", summary: "Numbers." },
      // Named by nothing it says: a decision on the record cites it.
      { ...call(82), summary: "Sequencing." },
    ];
    const db = goalFixtures(goal({ decisions: [{ key: "d0", text: "Brokers first", at: NOW - 900 * H, source: { kind: "call", ref: "cl-82:14" } }] }), [...quiet, ...buried]);
    const pages = await allPages(db, await goalScope(db), { kinds: ["call"] });
    expect(pages.flat().map((r) => r.short_id)).toEqual(["cl-80", "cl-81", "cl-82"]);
  });

  test("a page cut at the call cap holds back the older rows of every kind, so pages stay newest first", async () => {
    const db = goalFixtures(
      goal({ decisions: Array.from({ length: 40 }, (_, i) => ({ key: `d${i}`, text: `Decision ${i}`, at: NOW - (100 + i) * H })) }),
      Array.from({ length: 12 }, (_, i) => call(i)),
    );
    const pages = await allPages(db, await goalScope(db), { limit: 40 });
    const seen = pages.flat();
    expect(seen.length).toBe(52);
    expect(new Set(seen.map((r) => `${r.kind}:${r.id}`)).size).toBe(52);
    expect(seen.map((r) => r.id)).toEqual(inFeedOrder(seen).map((r) => r.id));
    // The first page stops at the eighth call; the ninth opens the next.
    expect(pages[0].map((r) => r.short_id)).toEqual(["cl-0", "cl-1", "cl-2", "cl-3", "cl-4", "cl-5", "cl-6", "cl-7"]);
    expect(pages[1][0].short_id).toBe("cl-8");
  });

  test("a scan that stops with calls unread holds back older rows and never ends the feed", async () => {
    // More quiet calls than one page scans, then one that names the goal, then
    // a milestone older than all of them.
    const quiet = Array.from({ length: 300 }, (_, i) => ({ ...call(i), summary: "Nothing about the goal." }));
    const db = goalFixtures(goal({ milestones: [{ key: "m0", title: "Beta", done_at: NOW - 900 * H }] }), [...quiet, call(400)]);
    const pages = await allPages(db, await goalScope(db));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat().map((r) => `${r.kind}:${r.short_id}`)).toEqual(["call:cl-400", "goal:in-1"]);
  });

  test("a goal with no projects reads none of the sources that need work in scope", async () => {
    const db = goalFixtures(goal({ milestones: [{ key: "m0", title: "Beta", done_at: NOW - H }] }), [call(1)]);
    const resolved = await goalScope(db);
    const c = countingDb(db);
    const { rows } = await computeScopeFeed(ctxOf(c.db), resolved, { now: NOW });
    expect(rows.map((r) => r.kind)).toEqual(["goal", "call"]);
    for (const table of ["docs", "artifacts", "session_decisions", "workflow_runs"]) expect(c.queried.has(table)).toBe(false);
  });

  test("the call scan stops reading once the rows it has passed fill the page", async () => {
    // 130 quiet calls an hour apart; 100 decisions half an hour apart, so one
    // window of calls already reaches past more decisions than a page holds.
    const quiet = Array.from({ length: 130 }, (_, i) => ({ ...call(i), summary: "Nothing about the goal." }));
    const db = goalFixtures(goal({ decisions: Array.from({ length: 100 }, (_, i) => ({ key: `d${i}`, text: `Decision ${i}`, at: NOW - (i + 1) * H / 2 })) }), quiet);
    const resolved = await goalScope(db);
    const c = countingDb(db);
    const first = await computeScopeFeed(ctxOf(c.db), resolved, { now: NOW, limit: 40 });
    expect(first.rows.length).toBe(40);
    expect(c.reads("transcripts")).toBe(60);
    // The next page is filled by rows the scan already passed: no call is read.
    const second = await computeScopeFeed(ctxOf(c.db), resolved, { now: NOW, limit: 40, cursor: first.next_cursor });
    expect(second.rows.length).toBe(40);
    expect(c.reads("transcripts")).toBe(60);
    const pages = await allPages(db, resolved, { limit: 40 });
    expect(pages.flat().map((r) => r.id)).toEqual(inFeedOrder(pages.flat()).map((r) => r.id));
    expect(pages.flat().length).toBe(100);
  });
});
