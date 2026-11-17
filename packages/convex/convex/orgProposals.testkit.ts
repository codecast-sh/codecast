// Shared fixtures for the orgProposals tests (orgProposals.test.ts,
// orgProposals.hires.test.ts): one team, an admin and a member, a growth role
// with its standing session, two projects and a loose plan.

import { makeFakeDb } from "./testDb";

export const ME = "u".repeat(31) + "m";
export const MATE = "u".repeat(31) + "t";
export const TEAM = "teams_acme" as any;
export const WS = `team:${TEAM}`;
export const NOW = 1_800_000_000_000;
export const P = "projects_growth";
export const Q = "projects_billing";
export const GROWTH = "org_roles_growth";
export const S1 = "conversations_analyzer";
export const S_GROWTH = "conversations_standing_growth";

export function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [
      { _id: GROWTH, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth lead", handle: "growth", trust: "understand", scope: { project_ids: [P], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchors_growth", created_by: ME, created_at: 1, updated_at: 1 },
    ],
    org_role_history: [],
    anchors: [{ _id: "anchors_growth", name: "Growth lead", scope_type: "team", team_id: TEAM, host_user_id: ME, bot_user_id: MATE, org_role_id: GROWTH, conversation_id: S_GROWTH, status: "active" }],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: 1 },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", created_at: 1, updated_at: 1 },
    ],
    plans: [{ _id: "plans_loose", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Loose", status: "active", doc_id: "docs_loose", created_at: 1, updated_at: 1 }],
    tasks: [], docs: [{ _id: "docs_loose", user_id: ME, team_id: TEAM, workspace: WS, title: "Loose", content: "", doc_type: "plan", plan_id: "plans_loose", created_at: 1, updated_at: 1 }], agent_tasks: [], session_owners: [], decision_inbox: [], session_decisions: [], decision_grants: [], org_proposals: [], org_proposal_changes: [],
    conversations: [
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Org analyzer", short_id: "jxanaly", session_id: "s1", project_path: "/repo", updated_at: NOW, created_at: 1, message_count: 3 },
      { _id: S_GROWTH, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude_code", title: "Growth lead", short_id: "jxgrowt", session_id: "s_growth", project_path: "/repo/growth", standing_role_id: GROWTH, anchor_id: "anchors_growth", persistent: true, updated_at: NOW, created_at: 1, message_count: 0 },
    ],
    ...extra,
  });
}
// A signed in browser: an auth identity and no token. Deciding is refused on
// any other evidence.
export const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: "browser" }) } }) as any;
export const tokenCtxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => null } }) as any;
export const change = (c: any, rationale = "because") => ({ change: c, rationale, evidence: [{ label: "ct-1", href: "/tasks/ct-1" }] });
export const spec = (changes: any[], over: Record<string, any> = {}) => ({ title: "Reshape growth", summary_md: "Two moves.", mode: "review", changes, ...over });
