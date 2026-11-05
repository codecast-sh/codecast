// Shared fixtures for the orgLine tests (orgLine.test.ts, orgLine.admission.test.ts):
// one team, one host, one line role with its standing session, one task.

import { makeFakeDb } from "./testDb";

export const HOST = "u".repeat(31) + "h"; // hosts the role, team admin
export const MATE = "u".repeat(31) + "t"; // plain member
export const TEAM = "teams_acme" as any;
export const ROLE = "org_roles_growth";
const ANCHOR = "anchors_growth";
export const STANDING = "conversations_standing";
const PROJECT = "projects_p1";
// The real clock: recordHandStart (spawn.ts) stamps counters with Date.now(),
// so a fixed timestamp would put the cap check on a different day.
export const NOW = Date.now();
export const TODAY = new Date(NOW).toISOString().slice(0, 10);

type Overrides = { role?: Record<string, any>; task?: Record<string, any>; extra?: Record<string, any[]> };

export function task(over: Record<string, any> = {}) {
  return {
    _id: "tasks_1",
    short_id: "ct-1",
    title: "Ship the thing",
    status: "open",
    priority: "medium",
    assignee: "agent:growth",
    project_id: PROJECT,
    user_id: HOST,
    team_id: TEAM,
    workspace: `team:${TEAM}`,
    created_at: NOW - 1000,
    updated_at: NOW - 1000,
    ...over,
  };
}

export function fixtures(o: Overrides = {}) {
  const db = makeFakeDb({
    users: [
      { _id: HOST, name: "Host", email: "host@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true, line: true } }],
    projects: [{ _id: PROJECT, title: "Growth", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }],
    plans: [],
    tasks: [task(o.task)],
    org_roles: [
      {
        _id: ROLE,
        short_id: "or-1",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Growth lead",
        handle: "growth",
        scope: { project_ids: [PROJECT], plan_ids: [] },
        reports_to: { kind: "user", user_id: HOST },
        status: "active",
        trust: "direct",
        anchor_id: ANCHOR,
        caps: { hands_per_day: 3, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
        created_by: HOST,
        created_at: 1,
        updated_at: 1,
        ...(o.role ?? {}),
      },
    ],
    anchors: [{ _id: ANCHOR, team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: STANDING }],
    conversations: [{ _id: STANDING, session_id: "standing", user_id: HOST, team_id: TEAM, status: "active", title: "Growth lead", agent_type: "claude_code", message_count: 1, standing_role_id: ROLE, anchor_id: ANCHOR, updated_at: NOW, project_path: "/srv/growth" }],
    workflows: [],
    workflow_runs: [],
    daemon_commands: [],
    messages: [],
    task_comments: [],
    org_role_history: [],
    directory_team_mappings: [],
    thread_reads: [],
    entity_subscriptions: [],
    counters: [],
    ...(o.extra ?? {}),
  });
  return { db, ctx: { db } as any, tables: db._tables as Record<string, any[]> };
}
