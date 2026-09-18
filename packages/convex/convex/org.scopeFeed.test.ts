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
      // In scope by project_path; asks a decision that names no task.
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth session", short_id: "jx1", project_path: "/repo/growth", updated_at: NOW - 7 * H, created_at: 1, message_count: 3 },
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
function countingDb(db: any): { db: any; reads: () => number } {
  let n = 0;
  const count = (rows: any) => { n += Array.isArray(rows) ? rows.length : rows ? 1 : 0; return rows; };
  const wrapBuilder = (b: any): any => new Proxy(b, {
    get(target, key) {
      const v = target[key];
      if (typeof v !== "function") return v;
      return (...args: any[]) => {
        const r = v.apply(target, args);
        if (key === "collect" || key === "take" || key === "first" || key === "unique") return r.then(count);
        return r === target ? wrapBuilder(r) : r;
      };
    },
  });
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === "query") return (table: string) => wrapBuilder(target.query(table));
      if (key === "get") return (id: any) => target.get(id).then(count);
      return target[key];
    },
  });
  return { db: counting, reads: () => n };
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
