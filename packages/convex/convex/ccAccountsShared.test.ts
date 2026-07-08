import { describe, expect, test } from "bun:test";
import { isAgentSpawnedConversation, isSubagentConversation, subagentLinkFields } from "./ccAccountsShared";

// Regression (ct-37439): a subagent active in the last 30d is pulled into the
// inbox via the top-level scan (recentConversations), NOT only as a child of its
// parent. The top-level row projection used to omit is_subagent /
// parent_conversation_id, so the client's isSubagentConversation returned false
// and the session rendered as a loose flat card instead of nesting under its
// parent. subagentLinkFields is the single projection both inbox emission paths
// spread, so a subagent self-identifies no matter which path emitted it.
describe("subagentLinkFields", () => {
  test("carries the parent link for a subagent (the row the client nests on)", () => {
    const row = subagentLinkFields({
      is_subagent: true,
      parent_conversation_id: "jx78arhhbhmg6g1vjcmt1k5s1188p13e",
    });
    expect(row).toEqual({
      is_subagent: true,
      parent_conversation_id: "jx78arhhbhmg6g1vjcmt1k5s1188p13e",
    });
    // The downstream client predicate must agree the row is a subagent.
    expect(isSubagentConversation(row)).toBe(true);
  });

  test("a genuine top-level conversation carries no parent link", () => {
    const row = subagentLinkFields({});
    expect(row).toEqual({ is_subagent: false, parent_conversation_id: null });
    expect(isSubagentConversation(row)).toBe(false);
  });

  test("a child with only a parent id (no is_subagent flag) still self-identifies", () => {
    // The parent_message_uuid-less child case: parent_conversation_id set, but the
    // row's own is_subagent flag is absent. The client falls back to the parent id.
    const row = subagentLinkFields({ parent_conversation_id: "jx78arh" });
    expect(row.is_subagent).toBe(false);
    expect(row.parent_conversation_id).toBe("jx78arh");
    expect(isSubagentConversation(row)).toBe(true);
  });

  test("stringifies a Convex Id object (server passes the id, not a string)", () => {
    const idObj = { toString: () => "jx78arhhbhmg6g1vjcmt1k5s1188p13e" };
    const row = subagentLinkFields({ is_subagent: true, parent_conversation_id: idObj });
    expect(row.parent_conversation_id).toBe("jx78arhhbhmg6g1vjcmt1k5s1188p13e");
    expect(typeof row.parent_conversation_id).toBe("string");
  });
});

// Regression (ct-38175): teammates got "X started coding" pushes for subagent
// sessions. notifyTeamSessionStart gates on this predicate at fire time (after
// a grace delay), so every agent-spawned shape must return true — including
// the ones whose links are stamped seconds after registration.
describe("isAgentSpawnedConversation", () => {
  test("THE BUG: a Task-tool subagent must never notify the team", () => {
    expect(isAgentSpawnedConversation({ is_subagent: true })).toBe(true);
  });

  test("a subagent linked late (parent id, no fork uuid) is agent-spawned", () => {
    expect(
      isAgentSpawnedConversation({ parent_conversation_id: "jx7parent" })
    ).toBe(true);
  });

  test("a workflow fan-out agent is agent-spawned", () => {
    expect(isAgentSpawnedConversation({ is_workflow_sub: true })).toBe(true);
  });

  test("an agent-team teammate (spawned_by link) is agent-spawned", () => {
    expect(
      isAgentSpawnedConversation({ spawned_by_conversation_id: "jx7lead" })
    ).toBe(true);
  });

  test("a teammate self-identified at create (agent_name from its transcript) is agent-spawned", () => {
    // The spawned_by link lands AFTER creation; the transcript's agent stamp
    // is present at create and must suppress on its own.
    expect(
      isAgentSpawnedConversation({ agent_name: "researcher", agent_team_name: "swarm" } as any)
    ).toBe(true);
  });

  test("the team LEAD (human-started, stamped agent_name team-lead) still notifies", () => {
    expect(
      isAgentSpawnedConversation({ agent_name: "team-lead", agent_team_name: "swarm" } as any)
    ).toBe(false);
  });

  test("a fork (parent link WITH parent_message_uuid) is a human action — notifies", () => {
    expect(
      isAgentSpawnedConversation({
        parent_conversation_id: "jx7parent",
        parent_message_uuid: "uuid-of-fork-point",
      })
    ).toBe(false);
  });

  test("a plain human session notifies", () => {
    expect(isAgentSpawnedConversation({})).toBe(false);
  });

  test("accepts Convex Id objects for the link fields", () => {
    const idObj = { toString: () => "jx7parent" };
    expect(isAgentSpawnedConversation({ spawned_by_conversation_id: idObj })).toBe(true);
    expect(isAgentSpawnedConversation({ parent_conversation_id: idObj })).toBe(true);
  });
});
