// A hand's briefing names the task it was started for. A workflow station is
// nested under its run's session, so it is briefed on the run's task; the
// spawning role session's own binding (which drifts between its hands) is
// only the fallback.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";

const OWNER = "users_owner";
const ROLE = "org_roles_r";

function fixture() {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    org_roles: [{ _id: ROLE, short_id: "or-1", name: "Agent Quality lead", handle: "agent-quality", status: "active", trust: "direct", host_user_id: OWNER, scope_type: "user", scope_user_id: OWNER }],
    tasks: [
      { _id: "tasks_lead", short_id: "ct-55739", title: "Eval tiers", user_id: OWNER, status: "in_progress" },
      { _id: "tasks_run", short_id: "ct-59509", title: "Sponsorship match", user_id: OWNER, status: "in_progress" },
    ],
    conversations: [
      { _id: "conversations_lead", user_id: OWNER, session_id: "lead-uuid", status: "active", org_role_id: ROLE, active_task_id: "tasks_lead" },
      { _id: "conversations_run", user_id: OWNER, session_id: "wf-run", status: "active", workflow_run_id: "workflow_runs_1", is_workflow_primary: true },
      { _id: "conversations_plain", user_id: OWNER, session_id: "plain-uuid", status: "active" },
    ],
    workflow_runs: [{ _id: "workflow_runs_1", user_id: OWNER, task_id: "tasks_run", primary_conversation_id: "conversations_run" }],
    managed_sessions: [],
  };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } } as any;
  return { ctx, tables };
}

const briefed = (tables: Record<string, any[]>): string => tables.pending_messages[0].content;

describe("a hand's briefing task", () => {
  test("a station spawned by the role's session is briefed on its run's task, not the session's binding", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "lead-uuid", parent_session: "wf-run", prompt: "Prove it" });
    const text = briefed(tables);
    expect(text).toContain("cast task handoff ct-59509");
    expect(text).not.toContain("ct-55739");
  });

  test("with no task named, the spawner's binding is used", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "lead-uuid", prompt: "Do it" });
    expect(briefed(tables)).toContain("cast task handoff ct-55739");
  });

  test("a worker nested under an ordinary session keeps the spawner's binding", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "lead-uuid", parent_session: "plain-uuid", prompt: "Do it" });
    expect(briefed(tables)).toContain("cast task handoff ct-55739");
  });
});
