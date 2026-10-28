import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { ORG_ROW_CAP, collectOrgSessions, computeScopeFeed, resolveScope } from "./org";
import { computeAnalysisOrg, computeAnalysisWork } from "./orgInit";

// What the org scan and the analyzer's org slice read, not only what they
// answer. Union's weekly review died on Convex's 100 MB read limit
// (2026-10-27): the scan filtered status after reading every completed child
// row of a member's month, the routine read walked every routine on the
// server, and each of 23 roles re-read the same workspace windows. A filter
// or a shared window does not change the answer, so only the reads show it.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const OTHER_TEAM = "teams_other" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const D = 24 * H;

const conv = (id: string, over: Record<string, any> = {}) => ({
  _id: id, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: id, short_id: id.slice(-7), session_id: `s_${id}`,
  is_private: false, updated_at: NOW - H, created_at: NOW - 2 * D, started_at: NOW - 2 * D, message_count: 2, last_message_role: "assistant", ...over,
});

function fixtures(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }, { _id: OUTSIDER, name: "Outsider" }],
    teams: [{ _id: TEAM, name: "Acme" }, { _id: OTHER_TEAM, name: "Other" }],
    team_memberships: [
      { _id: "team_memberships_1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "team_memberships_2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 2 },
      { _id: "team_memberships_3", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "admin", joined_at: 1 },
    ],
    org_roles: [], anchors: [], conversations: [], managed_sessions: [], messages: [], agent_tasks: [],
    projects: [], plans: [], tasks: [], docs: [], artifacts: [], session_decisions: [], workflow_runs: [],
    inbox_buckets: [], bucket_assignments: [], initiatives: [], project_updates: [], counters: [],
    ...extra,
  };
  return makeFakeDb(tables, { indexes: schemaIndexes(schema as any) });
}

/** The db with every index read recorded as table, index and the fields its
 *  range names; a `.filter` after the index is recorded too. */
function recording(db: any) {
  const reads: Array<{ table: string; index: string; eq: Record<string, any>; filtered: boolean }> = [];
  const recorder = (eq: Record<string, any>): any => new Proxy({}, {
    get: (_t, op) => (field: string, value: any) => { if (op === "eq") eq[field] = value; return recorder(eq); },
  });
  const wrap = (q: any, read?: { filtered: boolean }): any => new Proxy(q, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== "function") return v;
      if (prop === "withIndex") return (index: string, range?: any) => {
        const eq: Record<string, any> = {};
        if (range) range(recorder(eq));
        const entry = { table: (q as any).__table, index, eq, filtered: false };
        reads.push(entry);
        return wrap(v.call(target, index, range), entry);
      };
      if (prop === "filter" && read) return (...args: any[]) => { read.filtered = true; return wrap(v.apply(target, args), read); };
      return (...args: any[]) => { const out = v.apply(target, args); return out && typeof out === "object" && typeof out.then !== "function" ? wrap(out, read) : out; };
    },
  });
  const ctxDb = new Proxy(db, {
    get(target, prop) {
      if (prop === "query") return (table: string) => { const q = target.query(table); q.__table = table; return wrap(q); };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ctx: { db: ctxDb } as any, reads };
}

describe("org scan reads", () => {
  test("the scan reads active rows through a status index, never filtering completed rows out after reading them", async () => {
    const db = fixtures({
      conversations: [
        conv("conversations_live"),
        ...Array.from({ length: 50 }, (_, i) => conv(`conversations_done${i}`, { status: "completed", parent_conversation_id: "conversations_live", is_subagent: true })),
      ],
    });
    const { ctx, reads } = recording(db);
    const scan = await collectOrgSessions(ctx, ME as any, TEAM, NOW);
    expect([...scan.sessions.keys()]).toEqual(["conversations_live"]);
    const convReads = reads.filter((r) => r.table === "conversations");
    expect(convReads.length).toBeGreaterThan(0);
    for (const r of convReads) {
      expect(r.eq.status).toBe("active");
      expect(r.filtered).toBe(false);
    }
  });

  test("one member's flood of rows cannot use the whole cap: every member's sessions are read", async () => {
    const flood = Array.from({ length: ORG_ROW_CAP + 40 }, (_, i) => conv(`conversations_f${i}`, { updated_at: NOW - H - i }));
    const db = fixtures({ conversations: [...flood, conv("conversations_mate", { user_id: MATE, updated_at: NOW - 5 * D })] });
    const scan = await collectOrgSessions({ db } as any, ME as any, TEAM, NOW);
    expect(scan.truncated).toBe(true);
    expect(scan.sessions.has("conversations_mate")).toBe(true);
    expect(scan.sessions.size).toBe(ORG_ROW_CAP);
    // The heavy member's share is its newest rows: the second read continues
    // below the first, with no row read twice and none skipped.
    expect(scan.sessions.has("conversations_f0")).toBe(true);
    expect(scan.sessions.has(`conversations_f${ORG_ROW_CAP - 2}`)).toBe(true);
    expect(scan.sessions.has(`conversations_f${ORG_ROW_CAP - 1}`)).toBe(false);
  });

  test("roles reading feeds through one scan read the workspace's windows once", async () => {
    const roles = ["a", "b", "c"].map((h) => ({
      _id: `org_roles_${h}`, team_id: TEAM, workspace: WS, handle: h, name: h, status: "active", created_at: NOW - 30 * D,
      reports_to: { kind: "user", user_id: ME }, scope: { project_ids: [`projects_${h}`], plan_ids: [] },
    }));
    const db = fixtures({
      org_roles: roles,
      projects: ["a", "b", "c"].map((h) => ({ _id: `projects_${h}`, user_id: ME, team_id: TEAM, workspace: WS, title: h, status: "active", created_at: 1, updated_at: NOW - D })),
      tasks: ["a", "b", "c"].map((h) => ({ _id: `tasks_${h}`, user_id: ME, team_id: TEAM, workspace: WS, project_id: `projects_${h}`, triage_status: "active", short_id: `ct-${h}`, title: h, status: "open", created_at: 1, updated_at: NOW - D })),
      workflow_runs: [{ _id: "workflow_runs_1", user_id: ME, workspace: WS, task_id: "tasks_a", status: "running", updated_at: NOW - H, created_at: NOW - H }],
      conversations: [conv("conversations_live")],
    });
    const { ctx, reads } = recording(db);
    const scan = await collectOrgSessions(ctx, ME as any, TEAM, NOW);
    for (const role of roles) {
      const resolved = await resolveScope(ctx, ME as any, { role_id: role._id });
      await computeScopeFeed(ctx, resolved!, { limit: 1, now: NOW, scan });
    }
    const count = (table: string) => reads.filter((r) => r.table === table).length;
    expect(count("workflow_runs")).toBe(1);
    // One window per member (two), not one per member per role.
    expect(count("artifacts")).toBe(2);
    expect(count("docs")).toBe(2);
  });

  test("the org slice reads routines per member, never every routine on the server", async () => {
    const db = fixtures({
      conversations: [conv("conversations_job", { started_at: NOW - 20 * D, updated_at: NOW - 2 * D })],
      agent_tasks: [
        { _id: "agent_tasks_mine", user_id: ME, short_id: "tr-1", title: "Daily", originating_conversation_id: "conversations_job", schedule_type: "recurring", interval_ms: D, status: "scheduled", run_at: NOW + H, created_at: 1 },
        { _id: "agent_tasks_theirs", user_id: OUTSIDER, short_id: "tr-9", title: "Elsewhere", originating_conversation_id: "conversations_elsewhere", schedule_type: "recurring", interval_ms: D, status: "scheduled", run_at: NOW + H, created_at: 1 },
      ],
    });
    const { ctx, reads } = recording(db);
    const work = await computeAnalysisWork(ctx, ME as any, TEAM);
    const org = await computeAnalysisOrg(ctx, ME as any, TEAM, NOW, JSON.parse(JSON.stringify(work.handoff)));
    expect(org.sessions.long_running.rows.map((r: any) => r.routines.map((t: any) => t.short_id))).toEqual([["tr-1"]]);
    const routineReads = reads.filter((r) => r.table === "agent_tasks");
    expect(routineReads.length).toBeGreaterThan(0);
    for (const r of routineReads) expect([ME, MATE]).toContain(r.eq.user_id);
  });
});
