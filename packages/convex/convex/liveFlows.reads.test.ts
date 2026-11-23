import { describe, expect, test } from "bun:test";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";
import { LIVE_FLOW_SHOWN, liveFlowView } from "./liveFlows";
import { sweepCore } from "./orgLine";

// A live flow's view (liveFlows.liveFlowView) counts the machines its leads run on, then plans its queue: each count
// is keyed by the lead's seat and by the agents the flow needs, so leads seated in different folders of one checkout,
// and the queue's count beside the view's own, recounted every working run on the same machines and read every run's
// task again. Union's view read past the 100 MB a query may (Nov 22), and `cast flow show` and the Flows page failed.

const HOST = "u".repeat(31) + "h";
const TEAM = "teams_acme" as any;
const NOW = Date.now();
const ORIGIN_URL = "git@github.com:Acme/Union.git";
const ORIGIN = normalizeGitOrigin(ORIGIN_URL)!;
// Leads seated in different folders of one checkout: one pool of machines, a load key each.
const FOLDERS = ["a", "b", "c", "d"];
const RUNS = 24;
const SLOTS = 12;

const lead = (key: string) => ({
  role: {
    _id: `org_roles_${key}`, short_id: `or-${key}`, scope_type: "team", team_id: TEAM, host_user_id: HOST, name: `${key} lead`, handle: key,
    scope: { project_ids: [`projects_${key}`], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active", trust: "direct",
    anchor_id: `anchors_${key}`, caps: { line_on: true }, created_by: HOST, created_at: 1, updated_at: 1,
  },
  anchor: { _id: `anchors_${key}`, team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: `conversations_${key}` },
  conversation: { _id: `conversations_${key}`, session_id: key, user_id: HOST, team_id: TEAM, status: "active", title: `${key} lead`, agent_type: "claude_code", message_count: 1, standing_role_id: `org_roles_${key}`, anchor_id: `anchors_${key}`, updated_at: NOW, project_path: `/srv/union/${key}` },
  project: { _id: `projects_${key}`, short_id: `pj-${key}`, title: key, user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, owner_role_id: `org_roles_${key}`, created_at: 1, updated_at: 1 },
});
const leads = FOLDERS.map(lead);

const problem = (id: string, project: string, over: Record<string, any> = {}) => ({
  _id: `tasks_${id}`, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", priority: "medium", source: "signal", readiness: "ready", goal_ref: "none",
  project_id: `projects_${project}`, user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`,
  cause: { signal_count: 1, first_seen: 1, last_seen: 1, fingerprints: ["f"], scored: { score: 50, harm: 3, reach: 3, fixability: 3, reason: "r", root_cause: "c", at: 1, version: "1" } },
  created_at: NOW - 1000, updated_at: NOW - 1000, ...over,
});

/** `count` working runs spread over three pool hosts and four leads; `pooled: false` takes the checkout off the machines, so each lead's load is its runner's own. */
function fixtures(count = RUNS, o: { pooled?: boolean } = {}) {
  const pooled = o.pooled ?? true;
  const laptop = { _id: "devices_laptop", user_id: HOST, device_id: "dev-laptop", last_seen: NOW, git_plane: pooled ? [{ root: "/srv/union", origin: ORIGIN_URL, origin_ok: true }] : [] };
  const host = (id: string) => ({ _id: `devices_${id}`, user_id: HOST, device_id: id, last_seen: NOW, line_slots: pooled ? [{ root: `/home/ubuntu/${id}`, origin: ORIGIN, runs: SLOTS }] : [] });
  const runs = Array.from({ length: count }, (_, n) => ({
    _id: `workflow_runs_r${n}`, user_id: HOST, status: "running", org_role_id: `org_roles_${FOLDERS[n % FOLDERS.length]}`, task_id: `tasks_r${n}`,
    runner_device: `h${(n % 3) + 1}`, current_node_id: "build", node_statuses: [], created_at: NOW - n, updated_at: NOW - n,
  }));
  const db = makeFakeDb({
    users: [{ _id: HOST, name: "Host", email: "host@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true, line: true } }],
    projects: leads.map((l) => l.project),
    plans: [],
    tasks: [...FOLDERS.map((f) => problem(`q${f}`, f)), ...runs.map((r, n) => problem(`r${n}`, FOLDERS[n % FOLDERS.length], { status: "in_progress", workflow_run_id: r._id }))],
    org_roles: leads.map((l) => l.role),
    anchors: leads.map((l) => l.anchor),
    conversations: leads.map((l) => l.conversation),
    devices: [laptop, host("h1"), host("h2"), host("h3")],
    workflows: [{ _id: "workflows_spine", user_id: HOST, slug: "onefix", name: "onefix", label: "Fix flow", nodes: [{ id: "build", type: "agent", agent: "claude" }, { id: "critique", type: "agent", agent: "codex" }], edges: [], created_at: 1, updated_at: 1 }],
    live_flows: [{ _id: "live_flows_1", workspace: `team:${TEAM}`, team_id: TEAM, workflow_id: "workflows_spine", on: true, changed_by: HOST, changed_at: 1, created_at: 1 }],
    workflow_runs: runs,
    session_decisions: [],
    signals: [],
  });
  return { db, tables: db._tables as Record<string, any[]> };
}

/** The ctx a view reads through, counting every row a get or a query hands back, by table and row. */
function counting(db: any) {
  const reads = new Map<string, number>();
  const note = (rows: any[]) => {
    for (const r of rows) if (r?._id) reads.set(String(r._id), (reads.get(String(r._id)) ?? 0) + 1);
  };
  const wrap = (q: any): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (prop === "collect" || prop === "take") return async (...a: any[]) => { const out = await v.apply(target, a); note(out); return out; };
      if (prop === "first" || prop === "unique") return async (...a: any[]) => { const out = await v.apply(target, a); note([out]); return out; };
      return (...a: any[]) => { const out = v.apply(target, a); return out && typeof out === "object" && typeof out.collect === "function" ? wrap(out) : out; };
    },
  });
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "query") return (table: string) => wrap(target.query(table));
      if (prop === "get") return async (id: any) => { const row = await target.get(id); note([row]); return row; };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const of = (prefix: string) => [...reads].filter(([id]) => id.startsWith(prefix));
  return {
    ctx: { db: counted } as any,
    /** How many rows whose id starts with `prefix` were read, and the most times any one of them was. */
    table: (prefix: string) => ({ rows: of(prefix).length, most: Math.max(0, ...of(prefix).map(([, c]) => c)) }),
    /** How many times one row was read. */
    row: (id: string) => reads.get(id) ?? 0,
  };
}

describe("liveFlowView reads each run on the line's machines once", () => {
  test("however many seats share the pool, and with the queue's count beside the view's, each run and its task are read once for the load", async () => {
    const { db, tables } = fixtures();
    const reads = counting(db);
    const view = await liveFlowView(reads.ctx, tables.live_flows[0], NOW);
    expect(view.load).toEqual({ working: RUNS, cap: 3 * SLOTS });
    expect(view.machines).toEqual({ online: 3, total: 3 });
    expect(view.queue.map((q) => q.task_id).sort()).toEqual(FOLDERS.map((f) => `tasks_q${f}`));
    // Once for the machines' load, once for the runs the view lists.
    expect(reads.table("workflow_runs_")).toEqual({ rows: RUNS, most: 2 });
    expect(reads.table("tasks_r")).toEqual({ rows: RUNS, most: 1 });
  });

  test("a runner's own machine too, whatever folders its leads sit in", async () => {
    const { db, tables } = fixtures(RUNS, { pooled: false });
    const reads = counting(db);
    const view = await liveFlowView(reads.ctx, tables.live_flows[0], NOW);
    expect(view.load.working).toBe(RUNS);
    expect(reads.table("workflow_runs_")).toEqual({ rows: RUNS, most: 2 });
    expect(reads.table("tasks_r")).toEqual({ rows: RUNS, most: 1 });
  });

  test("it lists as many runs as it shows, newest first, and reads no others for the list", async () => {
    const count = LIVE_FLOW_SHOWN + 30;
    const { db, tables } = fixtures(count);
    const reads = counting(db);
    const view = await liveFlowView(reads.ctx, tables.live_flows[0], NOW);
    expect(view.running).toHaveLength(LIVE_FLOW_SHOWN);
    // Each lead's newest runs: r0 to r3 are the newest of the four.
    expect(view.running.slice(0, 1)).toEqual(["workflow_runs_r0"]);
    expect(new Set(view.running).size).toBe(LIVE_FLOW_SHOWN);
    // Read for the list: the runs it lists, and no others.
    const listed = tables.workflow_runs.filter((r) => reads.row(r._id) > 1).map((r) => r._id);
    expect(listed.sort()).toEqual([...view.running].sort());
  });

  test("a sweep plans through one pass too: a run on a machine that takes no start is read once, however many seats plan", async () => {
    // h1 is full; the free slots are on h2 and h3, and only a start's own machine is counted again.
    const { db, tables } = fixtures(3 * SLOTS - 2);
    const reads = counting(db);
    expect((await sweepCore(reads.ctx, NOW)).started.length).toBeGreaterThan(0);
    const onFull = tables.workflow_runs.filter((r) => r.runner_device === "h1");
    expect(onFull).toHaveLength(SLOTS);
    expect(Math.max(...onFull.map((r) => reads.row(r._id)))).toBe(1);
  });

  test("a sweep counts each machine afresh before every start, so no machine takes more runs than its slots", async () => {
    // Two slots free across the hosts and a problem waiting in each of the four leads' folders.
    const { db, tables } = fixtures(3 * SLOTS - 2);
    const res = await sweepCore({ db } as any, NOW);
    expect(res.started.length).toBeGreaterThan(0);
    for (const device of ["h1", "h2", "h3"]) {
      expect(tables.workflow_runs.filter((r) => r.runner_device === device && (r.status === "pending" || r.status === "running")).length).toBeLessThanOrEqual(SLOTS);
    }
  });
});
