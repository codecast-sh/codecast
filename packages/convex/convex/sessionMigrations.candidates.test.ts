import { describe, expect, test } from "bun:test";
import { collectMigrationCandidates, heldReason, movabilityFacts } from "./sessionMigrations";
import { makeFakeDb } from "./testDb";

const USER = "users_me" as any;
const LAPTOP = "laptop";

describe("collectMigrationCandidates", () => {
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
    const facts = await movabilityFacts(ctx, USER);
    const held = Object.fromEntries(conversations.map((c) => [c._id, heldReason(c as any, facts)]));
    expect(held.conversations_worker).toBeNull();
    expect(held.conversations_task).toContain("moves with its parent");
  });

  // The runner watches a step through a local handle; a moved step reads as a dead station.
  test("a running workflow step stays, named by short id or by its run's conversation", async () => {
    const now = Date.now();
    const conversations = [
      { _id: "jx78540bjtf69k6dyr4kk9ayk58geqyz", user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true },
      { _id: "conversations_tmuxstep", user_id: USER, owner_device_id: LAPTOP, status: "active", is_subagent: true, parent_conversation_id: "conversations_line" },
    ];
    const managed_sessions = conversations.map((c, i) => ({ _id: `managed_sessions_${i}`, user_id: USER, conversation_id: c._id, last_heartbeat: now - 1000 }));
    const workflow_runs = [
      { _id: "workflow_runs_1", user_id: USER, status: "running", node_statuses: [{ node_id: "implement", status: "running", session_id: "jx78540" }] },
      { _id: "workflow_runs_2", user_id: USER, status: "running", primary_conversation_id: "conversations_line", node_statuses: [{ node_id: "review", status: "running", session_id: "wf-review-ab12" }] },
      { _id: "workflow_runs_3", user_id: "users_other", status: "running", node_statuses: [] },
    ];
    const ctx = { db: makeFakeDb({ conversations, managed_sessions, workflow_runs }) } as any;
    const facts = await movabilityFacts(ctx, USER);
    for (const c of conversations) expect(heldReason(c as any, facts)).toContain("workflow step");
  });
});
