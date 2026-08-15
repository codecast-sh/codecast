import { describe, expect, test } from "bun:test";
import { activeWorkspaceKey, inWorkspace, filterByWorkspace } from "../workspaceScope";

// Guards the trap the human flagged: personal is a POSITIVE key requiring the
// viewer's id, so an unresolved viewer must match NOTHING (never everything).
describe("client workspace key", () => {
  const rows = [
    { _id: "a", workspace: "team:T1", team_id: "T1" },
    { _id: "b", workspace: "team:T2", team_id: "T2" },
    { _id: "c", workspace: "user:me", team_id: "T1" },   // routed to T1, private
    { _id: "d", workspace: "user:other" },
    { _id: "e", team_id: "T1" },                          // legacy, no key
    { _id: "f" },                                          // legacy, teamless
  ];

  test("team view: only that team's rows, and NOT a team-routed private row", () => {
    const key = activeWorkspaceKey("T1", "me");
    expect(key).toBe("team:T1");
    expect(filterByWorkspace(rows, key).map(r => r._id)).toEqual(["a", "e"]);
  });

  test("personal view: only the viewer's own rows", () => {
    const key = activeWorkspaceKey(null, "me");
    expect(key).toBe("user:me");
    expect(filterByWorkspace(rows, key).map(r => r._id)).toEqual(["c", "f"]);
  });

  test("UNRESOLVED VIEWER fails closed — empty, never everything", () => {
    const key = activeWorkspaceKey(null, null);
    expect(key).toBeNull();
    expect(filterByWorkspace(rows, key)).toEqual([]);
    expect(inWorkspace(rows[0], null)).toBe(false);
    expect(inWorkspace(rows[0], undefined)).toBe(false);
  });

  test("another member of T1 cannot reach the team-routed private row", () => {
    expect(inWorkspace(rows[2], activeWorkspaceKey("T1", "mate"))).toBe(false);
    expect(inWorkspace(rows[2], activeWorkspaceKey(null, "mate"))).toBe(false);
    expect(inWorkspace(rows[2], activeWorkspaceKey(null, "me"))).toBe(true);
  });
});
