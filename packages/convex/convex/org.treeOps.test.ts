import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { ORG_ROW_CAP, computeOrgTree } from "./org";

// org:tree died in prod on Convex's per-execution operation limit ("too many
// system operations", eg-2904 / eg-879, 2026-11-10..12; ct-73206). The tree
// paid reads per row and per seat: a newest-message probe for each non-idle
// row of up to ORG_ROW_CAP, a managed_sessions read per teammate row, a get
// per quiet standing session, and a get per role per scoped project or plan
// with no dedupe. The answer does not show this; only the operation count does.

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;
const D = 24 * H;
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const uid = (i: number) => `users_${String(i).padStart(4, "0")}`;
const ME = uid(0);
const MEMBERS = 20;
const ROLES = 40;
const SHARED_PROJECTS = 3;

function workspace(liveRows: number, managed_sessions: any[] = []) {
  const users = Array.from({ length: MEMBERS }, (_, i) => ({ _id: uid(i), name: `M${i}` }));
  const team_memberships = users.map((u, i) => ({ _id: `team_memberships_${i}`, user_id: u._id, team_id: TEAM, role: i === 0 ? "admin" : "member", joined_at: i + 1 }));
  const projects = Array.from({ length: SHARED_PROJECTS }, (_, i) => ({ _id: `projects_${i}`, user_id: ME, team_id: TEAM, workspace: WS, title: `P${i}`, status: "active", created_at: 1, updated_at: NOW - D }));
  const conversations: any[] = [];
  const anchors: any[] = [];
  const org_roles: any[] = [];
  for (let r = 0; r < ROLES; r++) {
    const standing = `conversations_standing${r}`;
    conversations.push({ _id: standing, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: `standing ${r}`, short_id: `st${r}`, session_id: `s_${standing}`, is_private: false, updated_at: NOW - 40 * D, created_at: NOW - 60 * D, message_count: 3, last_message_role: "assistant", anchor_id: `anchors_${r}` });
    anchors.push({ _id: `anchors_${r}`, team_id: TEAM, name: `A${r}`, status: "active", scope_type: "team", conversation_id: standing, org_role_id: `org_roles_${r}`, bot_user_id: ME, host_user_id: ME });
    org_roles.push({ _id: `org_roles_${r}`, team_id: TEAM, workspace: WS, handle: `r${r}`, name: `Role ${r}`, status: "active", created_at: NOW - 30 * D, reports_to: { kind: "user", user_id: ME }, anchor_id: `anchors_${r}`, scope: { project_ids: projects.map((p) => p._id), plan_ids: [] } });
  }
  // Non-idle rows across every member, no backfilled last role, so each one
  // is a row the classifier must decide from its newest message.
  for (let i = 0; i < liveRows; i++) {
    const owner = uid(i % MEMBERS);
    conversations.push({ _id: `conversations_${i}`, user_id: owner, team_id: TEAM, status: "active", agent_type: "claude_code", title: `c${i}`, short_id: `c${i}`, session_id: `s_${i}`, is_private: false, updated_at: NOW - 60_000 - i, created_at: NOW - D, started_at: NOW - D, message_count: 4 });
  }
  const db = makeFakeDb({
    users, teams: [{ _id: TEAM, name: "Acme" }], team_memberships, org_roles, anchors, conversations, projects,
    managed_sessions, messages: [], plans: [], tasks: [], docs: [], artifacts: [], user_presence: [], agent_tasks: [],
    session_decisions: [], workflow_runs: [], counters: [], inbox_buckets: [], bucket_assignments: [],
  }, { indexes: schemaIndexes(schema as any) });
  return db;
}

// Every db.get and every db.query is one operation against Convex's limit.
function counting(db: any) {
  const ops = { get: 0, query: 0, total: 0 };
  const ctxDb = new Proxy(db, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "get") return (...a: any[]) => { ops.get++; ops.total++; return v.apply(target, a); };
      if (prop === "query") return (...a: any[]) => { ops.query++; ops.total++; return v.apply(target, a); };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ctx: { db: ctxDb } as any, ops };
}

describe("org tree operations", () => {
  test("a full workspace's tree stays far under the per-execution operation limit", async () => {
    const { ctx, ops } = counting(workspace(ORG_ROW_CAP));
    const tree = await computeOrgTree(ctx, ME as any, TEAM, NOW);
    expect(tree.roles.length).toBe(ROLES);
    console.log("org tree ops at the row cap:", ops);
    expect(ops.total).toBeLessThanOrEqual(1000);
  }, 60_000);

  test("doubling the non-idle rows adds almost no operations", async () => {
    const small = counting(workspace(ORG_ROW_CAP / 2));
    await computeOrgTree(small.ctx, ME as any, TEAM, NOW);
    const big = counting(workspace(ORG_ROW_CAP));
    await computeOrgTree(big.ctx, ME as any, TEAM, NOW);
    console.log("ops at half cap:", small.ops.total, "at cap:", big.ops.total);
    expect(big.ops.total).toBeLessThanOrEqual(Math.ceil(small.ops.total * 1.1));
  }, 60_000);

  test("the newest teammate rows still read their own managed session", async () => {
    const managed = [{ _id: "managed_sessions_1", user_id: uid(1), conversation_id: "conversations_1", session_id: "s_1", last_heartbeat: NOW - 30_000, agent_status: "done", agent_status_updated_at: NOW - 30_000 }];
    const { ctx } = counting(workspace(ORG_ROW_CAP, managed));
    const tree: any = await computeOrgTree(ctx, ME as any, TEAM, NOW);
    expect(tree.people.find((p: any) => p.user_id === uid(1)).counts.done).toBe(1);
  }, 60_000);
});
