// Fixtures for the workflow gate tests: a run on a task, its spawner and primary sessions, and the gate's call.
import { makeFakeDb } from "./testDb";
import { pauseAtGateCore } from "./workflow_runs";
import { hashToken } from "./apiTokens";

export const HOST = "users_host" as any; // owns the run and the asking session
export const MATE = "users_mate" as any; // a teammate who can read the task
export const STRANGER = "users_stranger" as any; // no team membership
export const TEAM = "teams_acme" as any;
export const TOKEN = "gate-test-token";
export const RUN = "workflow_runs_run";
export const TASK = "tasks_t1";
export const NOW = 1_800_000_000_000;

export const choices = [
  { key: "A", label: "[A] Approve", description: "ships now", target: "exit" },
  { key: "B", label: "[B] Revise", description: "another round", target: "implement" },
];

export async function seed(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Host" },
      { _id: MATE, name: "Mate" },
      { _id: STRANGER, name: "Stranger" },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
    ],
    api_tokens: [
      { _id: "token_host", user_id: HOST, token_hash: await hashToken(TOKEN) },
      { _id: "token_stranger", user_id: STRANGER, token_hash: await hashToken("stranger-token") },
    ],
    org_roles: [],
    session_owners: [],
    directory_team_mappings: [],
    conversations: [
      // The session that started the run: the asker (L4 step 1).
      { _id: "conversations_spawner", session_id: "sess-spawner", user_id: HOST, team_id: TEAM, message_count: 2 },
      { _id: "conversations_primary", session_id: `wf-${RUN}`, user_id: HOST, team_id: TEAM, message_count: 1, workflow_run_id: RUN, is_workflow_primary: true },
    ],
    tasks: [{ _id: TASK, short_id: "ct-7", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, title: "Ship the thing", status: "in_progress", task_type: "task", priority: "medium", workflow_run_id: RUN }],
    workflows: [{ _id: "workflows_line", user_id: HOST, name: "line", slug: "line", nodes: [{ id: "review", label: "Review", shape: "hexagon", type: "human" }], edges: [] }],
    workflow_runs: [{
      _id: RUN, user_id: HOST, workflow_id: "workflows_line", task_id: TASK, status: "running", node_statuses: [],
      workspace: `team:${TEAM}`, team_id: TEAM,
      spawner_conversation_id: "conversations_spawner", primary_conversation_id: "conversations_primary",
      created_at: NOW, updated_at: NOW,
    }],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    docs: [],
    counters: [],
    pending_messages: [],
    daemon_commands: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const ctx = { db, scheduler: { runAfter: async () => null }, async runMutation() { return null; } } as any;
  return { ctx, tables, db };
}

export const asUser = (ctx: any, userId: string) => ({ ...ctx, auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } } });

export async function pause(ctx: any, extra: Record<string, any> = {}) {
  return pauseAtGateCore(ctx, { userId: HOST }, {
    run_id: RUN as any,
    node_id: "review",
    prompt: "Ship the branch?\nThe reviewer approved with two notes.",
    choices,
    ...extra,
  });
}
