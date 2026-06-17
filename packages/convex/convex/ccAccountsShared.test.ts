import { describe, expect, test } from "bun:test";
import { isSubagentConversation, subagentLinkFields } from "./ccAccountsShared";

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
