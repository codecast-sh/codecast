import { describe, expect, test } from "bun:test";
import { collectMigrationCandidates, heldReason, movabilityFacts } from "./sessionMigrations";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";

const USER = "users_me" as any;
const LAPTOP = "laptop";

describe("collectMigrationCandidates", () => {
  // A bulk move leaves closed sessions where they are, as it does killed ones:
  // moving one would have to resume it there. They wake on the old machine.
  test("a closed or killed session is not a candidate, by either path", async () => {
    const now = Date.now();
    const closed = { user_id: USER, owner_device_id: LAPTOP, status: "active", inbox_dismissed_at: 5, inbox_closed_at: 5 };
    const conversations = [
      { _id: "conversations_seat", _creationTime: 1, ...closed, standing_role_id: "roles_1" },
      { _id: "conversations_killed", _creationTime: 2, user_id: USER, owner_device_id: LAPTOP, status: "completed", inbox_dismissed_at: 5, inbox_killed_at: 5 },
      { _id: "conversations_open", _creationTime: 3, user_id: USER, owner_device_id: LAPTOP, status: "active" },
      { _id: "conversations_live_closed", _creationTime: 4, ...closed, owner_device_id: "elsewhere" },
    ];
    const managed_sessions = [{ _id: "managed_sessions_1", user_id: USER, conversation_id: "conversations_live_closed", last_heartbeat: now - 30_000 }];
    const ctx = { db: makeFakeDb({ conversations, managed_sessions }) } as any;
    const ids = (await collectMigrationCandidates(ctx, USER, [{ device_id: LAPTOP }])).map((c) => String(c._id));
    expect(ids).toEqual(["conversations_open"]);
  });

  // A machine that spawns workers creates hundreds of conversations a day, so a
  // session started yesterday is past the per-device creation window while it is
  // still running. The resource sheet then had nothing to judge it by.
  test("a live session older than the newest 300 is still a candidate", async () => {
    const now = Date.now();
    const conversations = [
      { _id: "conversations_old", _creationTime: 1, user_id: USER, owner_device_id: LAPTOP, status: "active", agent_type: "claude_code" },
      ...Array.from({ length: 300 }, (_, i) => ({ _id: `conversations_${i}`, _creationTime: 100 + i, user_id: USER, owner_device_id: LAPTOP, status: "active" })),
    ];
    const managed_sessions = [{ _id: "managed_sessions_1", user_id: USER, conversation_id: "conversations_old", last_heartbeat: now - 30_000 }];
    const ctx = { db: makeFakeDb({ conversations, managed_sessions }) } as any;
    const ids = (await collectMigrationCandidates(ctx, USER, [{ device_id: LAPTOP }])).map((c) => String(c._id));
    expect(ids).toContain("conversations_old");
    expect(ids.filter((id) => id === "conversations_old").length).toBe(1);
  });

  // A spawned worker runs its own agent: when it burns the laptop's CPU, moving
  // its parent frees nothing, so it has to be offered on its own.
  test("a subagent with its own live agent is a candidate that moves on its own", async () => {
    const now = Date.now();
    const conversations = [
      { _id: "conversations_parent", _creationTime: 1, user_id: USER, owner_device_id: LAPTOP, status: "active" },
      { _id: "conversations_worker", _creationTime: 2, user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_parent" },
      { _id: "conversations_task", _creationTime: 3, user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_parent" },
    ];
    const managed_sessions = [{ _id: "managed_sessions_1", user_id: USER, conversation_id: "conversations_worker", last_heartbeat: now - 30_000 }];
    const ctx = { db: makeFakeDb({ conversations, managed_sessions, workflow_runs: [] }) } as any;
    const found = await collectMigrationCandidates(ctx, USER, [{ device_id: LAPTOP }]);
    expect(found.map((c) => String(c._id))).toContain("conversations_worker");
    const facts = await movabilityFacts(ctx, USER, conversations);
    const held = Object.fromEntries(conversations.map((c) => [c._id, heldReason(c as any, facts)]));
    expect(held.conversations_worker).toBeNull();
    expect(held.conversations_task).toContain("moves with its parent");
  });

  // The runner watches a step through a local handle; a moved step reads as a dead station.
  // The runs are read by key from the steps' own conversations, never by scanning the account's live runs.
  test("a running workflow step stays, named by short id, by session id or by its run's conversation", async () => {
    const now = Date.now();
    const conversations = [
      // Nested under a person's session that launched the run: the run names it by short id.
      { _id: "jx78540bjtf69k6dyr4kk9ayk58geqyz", user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_person" },
      { _id: "conversations_tmuxstep", user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_line" },
      // Reported by its session id, so the runner linked it to the run.
      { _id: "conversations_linked", session_id: "wf-review-cd34", workflow_run_id: "workflow_runs_3", user_id: USER, owner_device_id: LAPTOP, status: "active" },
    ];
    const parents = [
      { _id: "conversations_person", user_id: USER, status: "active", workflow_run_id: "workflow_runs_1" },
      { _id: "conversations_line", user_id: USER, status: "active", workflow_run_id: "workflow_runs_2", is_workflow_primary: true },
    ];
    const managed_sessions = conversations.map((c, i) => ({ _id: `managed_sessions_${i}`, user_id: USER, conversation_id: c._id, last_heartbeat: now - 1000 }));
    const workflow_runs = [
      { _id: "workflow_runs_1", user_id: USER, status: "running", node_statuses: [{ node_id: "implement", status: "running", session_id: "jx78540" }] },
      { _id: "workflow_runs_2", user_id: USER, status: "running", primary_conversation_id: "conversations_line", node_statuses: [{ node_id: "review", status: "running", session_id: "wf-review-ab12" }] },
      { _id: "workflow_runs_3", user_id: USER, status: "paused", node_statuses: [{ node_id: "review", status: "running", session_id: "wf-review-cd34" }] },
    ];
    const ctx = { db: makeFakeDb({ conversations: [...conversations, ...parents], managed_sessions, workflow_runs }) } as any;
    const facts = await movabilityFacts(ctx, USER, conversations);
    for (const c of conversations) expect(heldReason(c as any, facts)).toContain("workflow step");
    // An ended run, or another account's, holds nothing.
    workflow_runs[0].status = "completed";
    workflow_runs[2].user_id = "users_other";
    const after = await movabilityFacts(ctx, USER, conversations);
    expect(heldReason(conversations[0] as any, after) ?? "").not.toContain("workflow step");
    expect(heldReason(conversations[2] as any, after)).toBeNull();
  });

  // A person's session launches run A, then run B: its pointer names B. B ends while A's station still runs.
  test("a step of an older run launched from a person's session stays after the session's newer run ends", async () => {
    const now = Date.now();
    const conversations = [
      { _id: "jx7aaaabjtf69k6dyr4kk9ayk58geqyz", _creationTime: 1, user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_person" },
    ];
    const person = { _id: "conversations_person", _creationTime: 0, user_id: USER, status: "active", workflow_run_id: "workflow_runs_b" };
    const managed_sessions = [{ _id: "managed_sessions_0", user_id: USER, conversation_id: conversations[0]._id, last_heartbeat: now - 1000 }];
    const workflow_runs = [
      { _id: "workflow_runs_a", _creationTime: 1, user_id: USER, status: "running", primary_conversation_id: "conversations_person", node_statuses: [{ node_id: "implement", status: "running", session_id: "jx7aaaa" }] },
      { _id: "workflow_runs_b", _creationTime: 2, user_id: USER, status: "completed", primary_conversation_id: "conversations_person", node_statuses: [] },
    ];
    const ctx = { db: makeFakeDb({ conversations: [...conversations, person], managed_sessions, workflow_runs }, { indexes: schemaIndexes(schema as any) }) } as any;
    const facts = await movabilityFacts(ctx, USER, conversations);
    expect(heldReason(conversations[0] as any, facts)).toContain("workflow step");
  });
});
