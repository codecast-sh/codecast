// The hands a standing session started (scopes-and-feed.md F4.2): the rows a
// wake card renders under a person's message. A hand is a row spawned by the
// standing session that carries the role pointer; a spawned row without the
// pointer (a review hand, a plain subagent) is not one. Oldest first, with
// the pinned state and the task, and nothing for a viewer the standing
// session is closed to.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { handsStartedBy } from "./org";

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;
const STANDING = "c".repeat(31) + "s";
const ROLE = "org_roles_1";

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: OUTSIDER, name: "Out", email: "out@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    org_roles: [{ _id: ROLE, short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Infra lead", handle: "infra-lead", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", created_by: ME, created_at: 1, updated_at: 1 }],
    tasks: [{ _id: "tasks_1", user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, short_id: "ct-52058", title: "CI red", task_type: "task", status: "in_progress", priority: "high", created_at: 1, updated_at: 1 }],
    conversations: [
      { _id: STANDING, session_id: "s0", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Infra lead", agent_type: "claude_code", standing_role_id: ROLE, message_count: 3, last_message_role: "assistant", started_at: NOW - 10_000, updated_at: NOW - 100 },
      // Two hands, started in this order.
      { _id: "h".repeat(31) + "2", session_id: "s2", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Write the runbook", agent_type: "claude_code", org_role_id: ROLE, spawned_by_conversation_id: STANDING, message_count: 1, last_message_role: "assistant", started_at: NOW - 4_000, updated_at: NOW - 4_000 },
      { _id: "h".repeat(31) + "1", session_id: "s1", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Get CI green", agent_type: "claude_code", org_role_id: ROLE, spawned_by_conversation_id: STANDING, active_task_id: "tasks_1", thread_state: "bisecting the five red jobs\nStatus: two look like one fixture", thread_state_status: "working", thread_state_at: NOW - 3_000, message_count: 2, last_message_role: "assistant", started_at: NOW - 5_000, updated_at: NOW - 3_000 },
      // Spawned by the standing session but not filed under the role: not a hand.
      { _id: "r".repeat(31) + "1", session_id: "s3", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Review of ct-52058", agent_type: "claude_code", spawned_by_conversation_id: STANDING, review_of_task_id: "tasks_1", message_count: 1, last_message_role: "assistant", started_at: NOW - 2_000, updated_at: NOW - 2_000 },
      // A hand of the role spawned by someone else: not this session's.
      { _id: "e".repeat(31) + "1", session_id: "s4", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Elsewhere", agent_type: "claude_code", org_role_id: ROLE, spawned_by_conversation_id: "x".repeat(32), message_count: 1, last_message_role: "assistant", started_at: NOW - 1_000, updated_at: NOW - 1_000 },
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
    anchors: [],
    directory_team_mappings: [],
  });
}

const asUser = (db: any, id: string) => ({ db, auth: { getUserIdentity: async () => ({ subject: id }) } }) as any;

describe("org.handsStartedBy", () => {
  test("lists the standing session's hands oldest first, with the pinned state and the task, and skips rows that are not hands", async () => {
    const rows: any[] = await (handsStartedBy as any)._handler(asUser(fixtures(), ME), { conversation_id: STANDING });
    expect(rows.map((r) => r.title)).toEqual(["Get CI green", "Write the runbook"]);
    const first = rows[0];
    expect(first.started_at).toBe(NOW - 5_000);
    expect(first.task_short_id).toBe("ct-52058");
    expect(first.state_line).toBe("bisecting the five red jobs");
    expect(first.state_status).toBe("working");
    expect(["working", "needs_input", "done", "dormant", "idle"]).toContain(first.state);
    expect(rows[1].task_short_id).toBeNull();
    expect(rows[1].state_line).toBeNull();
  });

  test("a teammate who can see the standing session reads the same rows; a stranger reads none", async () => {
    const mate: any[] = await (handsStartedBy as any)._handler(asUser(fixtures(), MATE), { conversation_id: STANDING });
    expect(mate).toHaveLength(2);
    const out: any[] = await (handsStartedBy as any)._handler(asUser(fixtures(), OUTSIDER), { conversation_id: STANDING });
    expect(out).toEqual([]);
  });

  test("a session that started nothing has no hands", async () => {
    const rows: any[] = await (handsStartedBy as any)._handler(asUser(fixtures(), ME), { conversation_id: "h".repeat(31) + "1" });
    expect(rows).toEqual([]);
  });
});
