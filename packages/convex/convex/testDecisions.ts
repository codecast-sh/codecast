// The world sessionDecisions tests run against: the team, its roles and
// reporting line, the asking sessions, and helpers that ask or seat roles.
import { makeFakeDb } from "./testDb";
import { askCore } from "./sessionDecisions";

export const HOST = "users_host" as any; // hosts the roles, owns the asking session
export const BOSS = "users_boss" as any; // the person the role chain reports to
export const OWNER2 = "users_owner2" as any; // a second session owner
export const TEAM = "teams_acme" as any;
export const NOW = 1_800_000_000_000;

export function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Host" },
      { _id: BOSS, name: "Boss" },
      { _id: OWNER2, name: "Owner Two" },
    ],
    teams: [{ _id: TEAM, features: { org: true } }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: BOSS, team_id: TEAM, role: "admin" },
    ],
    org_roles: [
      {
        _id: "org_roles_lead",
        short_id: "or-1",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Growth lead",
        handle: "growth",
        scope: { project_ids: ["projects_p1"], plan_ids: [] },
        reports_to: { kind: "role", role_id: "org_roles_head" },
        status: "active",
        // W1 trust stage: a role at "understand" may recommend but not answer.
        trust: "decide",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        _id: "org_roles_paused",
        short_id: "or-2",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Paused seat",
        handle: "paused",
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "role", role_id: "org_roles_lead" },
        status: "paused",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
      {
        _id: "org_roles_head",
        short_id: "or-3",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Head",
        handle: "head",
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "user", user_id: BOSS },
        status: "active",
        created_by: HOST,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    conversations: [
      // The asking session reports to the growth lead. Host is the primary
      // owner (owner_user_id + session_owners); OWNER2 is a second owner.
      { _id: "conversations_ask", session_id: "sess-ask", user_id: HOST, owner_user_id: HOST, team_id: TEAM, message_count: 10, org_role_id: "org_roles_lead" },
      // The growth lead's own standing session.
      { _id: "conversations_lead", session_id: "sess-lead", user_id: HOST, team_id: TEAM, message_count: 3, org_role_id: "org_roles_lead" },
      // A second asker under the same role (the "2 askers" rule).
      { _id: "conversations_ask2", session_id: "sess-ask2", user_id: HOST, team_id: TEAM, message_count: 4, org_role_id: "org_roles_lead" },
      // A session with no role at all.
      { _id: "conversations_plain", session_id: "sess-plain", user_id: HOST, message_count: 1 },
      // A standing role session owned by someone other than its runner: the
      // parent chain must not keep questions on the founder's stack.
      { _id: "conversations_standing", session_id: "sess-standing", user_id: HOST, owner_user_id: OWNER2, team_id: TEAM, message_count: 2, standing_role_id: "org_roles_lead" },
    ],
    session_owners: [
      { _id: "so0", conversation_id: "conversations_ask", user_id: HOST, added_by: HOST, added_at: NOW - 1 },
      { _id: "so1", conversation_id: "conversations_ask", user_id: OWNER2, added_by: HOST, added_at: NOW },
      { _id: "so_stand", conversation_id: "conversations_standing", user_id: OWNER2, added_by: HOST, added_at: NOW },
    ],
    tasks: [{ _id: "tasks_t1", short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Ship the thing", status: "in_review", project_id: "projects_p1", task_type: "task", priority: "medium" }],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    docs: [],
    counters: [],
    pending_messages: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  // Jobs the code schedules, recorded rather than run: a test runs one by
  // calling its core.
  const scheduled: { ms: number; args: any }[] = [];
  const scheduler = { runAfter: async (ms: number, _fn: unknown, args: any) => { scheduled.push({ ms, args }); } };
  return { ctx: { db, scheduler } as any, tables, db, scheduled };
}

export const twoOptions = [
  { label: "Keep vendored", description: "no change" },
  { label: "Switch to upstream", description: "one afternoon of work" },
];

export async function askApproach(ctx: any, session = "sess-ask", question = "Keep the engine vendored?") {
  return askCore(ctx, { userId: HOST }, {
    session_id: session,
    question,
    options: twoOptions,
    context_md: "Reasoning goes here.",
    category: "approach",
  });
}

// Both roles seated, so each can be told: the lead on conversations_standing,
// the head (which reports to BOSS) on conversations_head.
export async function seated() {
  const world = seed();
  const { ctx } = world;
  await ctx.db.insert("anchors", { _id: "anchors_lead", conversation_id: "conversations_standing", status: "active" });
  await ctx.db.insert("anchors", { _id: "anchors_head", conversation_id: "conversations_head", status: "active" });
  await ctx.db.patch("org_roles_lead", { anchor_id: "anchors_lead" });
  await ctx.db.patch("org_roles_head", { anchor_id: "anchors_head" });
  await ctx.db.patch("conversations_standing", { org_role_id: "org_roles_head", anchor_id: "anchors_lead" });
  await ctx.db.insert("conversations", { _id: "conversations_head", session_id: "sess-head", user_id: HOST, team_id: TEAM, message_count: 2, standing_role_id: "org_roles_head", anchor_id: "anchors_head" });
  return world;
}
export const linesIn = (tables: Record<string, any[]>, conv: string) => tables.pending_messages.filter((m) => m.conversation_id === conv).map((m) => String(m.content));
