// A role's hand is a worker of the session that started it: nested under that
// session (so its settle wakes it), started on the brief exactly as written,
// filed under the role and marked unattended. A workflow station keeps its
// run's session as its parent.
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

const firstTurn = (tables: Record<string, any[]>): string => tables.pending_messages[0].content;
const hand = (tables: Record<string, any[]>) => tables.conversations.find((c) => c.session_id !== "lead-uuid" && c.session_id !== "wf-run" && c.session_id !== "plain-uuid");

describe("a role's hand", () => {
  test("nests under the role session that started it, on the brief as written", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "lead-uuid", prompt: "Do it" });
    expect(hand(tables)).toMatchObject({ parent_conversation_id: "conversations_lead", is_subagent: true, org_role_id: ROLE, unattended: true });
    expect(firstTurn(tables)).toBe("Do it");
  });

  test("a station keeps its run's session as its parent and its own brief", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "lead-uuid", parent_session: "wf-run", prompt: "Prove it" });
    expect(hand(tables)).toMatchObject({ parent_conversation_id: "conversations_run", org_role_id: ROLE });
    expect(firstTurn(tables)).toBe("Prove it");
  });

  test("a session outside any role spawns with no parent it did not ask for", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "plain-uuid", prompt: "Do it" });
    expect(hand(tables)?.parent_conversation_id).toBeUndefined();
  });
});
