// A role's hand is a worker of the session that started it: nested under that
// session (so its settle wakes it), started on the brief exactly as written,
// filed under the role and marked unattended. A workflow station keeps its
// run's session as its parent.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";
import { heldByRoleAlone } from "./conversations";

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
      { _id: "conversations_lead", user_id: OWNER, session_id: "lead-uuid", status: "active", org_role_id: ROLE, role_started: true, active_task_id: "tasks_lead" },
      { _id: "conversations_run", user_id: OWNER, session_id: "wf-run", status: "active", workflow_run_id: "workflow_runs_1", is_workflow_primary: true },
      { _id: "conversations_plain", user_id: OWNER, session_id: "plain-uuid", status: "active" },
      { _id: "conversations_standing", user_id: OWNER, session_id: "standing-uuid", status: "active", standing_role_id: ROLE, anchor_id: "anchors_r" },
      // A person's own session a task binding filed under the role (cast task start in its area).
      { _id: "conversations_bound", user_id: OWNER, session_id: "bound-uuid", status: "active", org_role_id: ROLE, org_role_hold: "bound" },
      // A hand the role started that a person took over.
      { _id: "conversations_taken", user_id: OWNER, session_id: "taken-uuid", status: "active", org_role_id: ROLE, role_started: true, driver_user_id: OWNER },
    ],
    workflow_runs: [{ _id: "workflow_runs_1", user_id: OWNER, task_id: "tasks_run", primary_conversation_id: "conversations_run" }],
    managed_sessions: [],
  };
  const db = makeFakeDb(tables);
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } } as any;
  return { ctx, tables };
}

const firstTurn = (tables: Record<string, any[]>): string => tables.pending_messages[0].content;
const SEEDED = new Set(["lead-uuid", "wf-run", "plain-uuid", "standing-uuid", "bound-uuid", "taken-uuid"]);
const hand = (tables: Record<string, any[]>) => tables.conversations.find((c) => !SEEDED.has(c.session_id));

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

  // Who started it decides whose it is (shared actsForRole): the role acts
  // through its standing session and through a session it started and still
  // drives. A person's session filed under the role starts the person's work.
  test("a hand the role's standing session starts is the role's start: no person owner, out of the runner's inbox", async () => {
    const { ctx, tables } = fixture();
    await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: "standing-uuid", prompt: "Do it" });
    expect(hand(tables)).toMatchObject({ org_role_id: ROLE, role_started: true });
    expect((tables.session_owners ?? []).filter((o) => o.conversation_id === hand(tables)._id)).toEqual([]);
    expect(await heldByRoleAlone(ctx, hand(tables))).toBe(true);
  });

  for (const [name, spawner] of [["a person's session a task binding filed under the role", "bound-uuid"], ["a hand a person took over", "taken-uuid"]] as const) {
    test(`a worker that ${name} spawns is a plain worker: not filed, not counted, not held to the role's limits`, async () => {
      const { ctx, tables } = fixture();
      // A paused role refuses every hand; this is no hand of its.
      tables.org_roles[0].status = "paused";
      await (createSessionFromCli as any)._handler(ctx, { agent_type: "claude_code", spawner_session: spawner, prompt: "Investigate" });
      const worker = hand(tables);
      expect(worker.org_role_id).toBeUndefined();
      expect(worker.role_started).toBeUndefined();
      expect(worker.unattended).toBeUndefined();
      expect(tables.org_roles[0].counters).toBeUndefined();
      expect(await heldByRoleAlone(ctx, worker)).toBe(false);
    });
  }
});
