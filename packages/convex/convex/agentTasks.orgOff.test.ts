import { expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { claimTask, getDueTasks } from "./agentTasks";

// A role's trigger waits while its team has the Org feature off, and fires
// again, untouched, once Org is back on. A plain trigger never notices.
async function fixture() {
  const roleTask = { _id: "agent_tasks_role", user_id: "users_one", role_id: "org_roles_qa", title: "Review", prompt: "Review open work", short_id: "tr-1", status: "scheduled", schedule_type: "recurring", interval_ms: 60_000, run_at: 1, run_count: 0, retry_count: 0, max_retries: 3 };
  const plainTask = { ...roleTask, _id: "agent_tasks_plain", role_id: undefined, short_id: "tr-2" };
  const tables: any = {
    agent_tasks: [roleTask, plainTask],
    users: [{ _id: "users_one" }],
    teams: [{ _id: "teams_acme", name: "Acme", features: {} }],
    team_memberships: [{ _id: "team_memberships_1", user_id: "users_one", team_id: "teams_acme", role: "admin" }],
    org_roles: [{ _id: "org_roles_qa", team_id: "teams_acme", scope_type: "team", handle: "qa", status: "active" }],
    api_tokens: [{ _id: "api_tokens_one", user_id: "users_one", token_hash: await hashToken("test") }],
  };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "users_one|session" }) }, scheduler: { runAfter: async () => null } } as any;
  return { ctx, tables };
}

test("a role's trigger waits while Org is off and fires once it is back on", async () => {
  const { ctx, tables } = await fixture();
  const due = async () => ((await (getDueTasks as any)._handler(ctx, { api_token: "test" })) as any[]).map((t) => t._id);
  expect(await due()).toEqual(["agent_tasks_plain"]);
  expect(await (claimTask as any)._handler(ctx, { api_token: "test", task_id: "agent_tasks_role", daemon_id: "d" })).toBeNull();
  expect(tables.agent_tasks[0].status).toBe("scheduled");

  tables.teams[0].features = { org: true };
  expect((await due()).sort()).toEqual(["agent_tasks_plain", "agent_tasks_role"]);
  expect((await (claimTask as any)._handler(ctx, { api_token: "test", task_id: "agent_tasks_role", daemon_id: "d" }))?.status).toBe("running");
});
