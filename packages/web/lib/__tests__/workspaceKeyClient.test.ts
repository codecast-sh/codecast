import { describe, expect, test } from "bun:test";
import { activeWorkspaceKey, filterSameWorkspace, inWorkspace, filterByWorkspace, sameWorkspaceAs, workspaceKeyOfRow } from "../workspaceScope";

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

  // A view scoped to another ROW's workspace (a task's blockers, what was
  // found during it) reads BOTH sides through workspaceKeyOfRow. inWorkspace's
  // personal branch is loose on purpose — a legacy row with neither key nor
  // team passes for the VIEWER's own key, which is right for enumerating what
  // the viewer can see and wrong relative to a row: such a row may be a
  // teammate's, held in the store because it is assigned to the viewer.
  test("row-relative scope: a teammate's legacy personal row is not a sibling of mine", () => {
    const mine = { _id: "g", user_id: "me" };            // legacy, teamless, mine
    const theirs = { _id: "h", user_id: "mate" };        // legacy, teamless, theirs
    const key = workspaceKeyOfRow(mine);
    expect(key).toBe("user:me");
    expect(inWorkspace(theirs, key)).toBe(true);         // the loose viewer-relative read
    expect(sameWorkspaceAs(theirs, key)).toBe(false);    // the row-relative one
    expect(sameWorkspaceAs(mine, key)).toBe(true);
    expect(filterSameWorkspace([mine, theirs, ...rows], key).map((r) => r._id)).toEqual(["g", "c"]);
  });

  test("row-relative scope fails closed on an unresolvable key", () => {
    expect(sameWorkspaceAs({ _id: "i", user_id: "me" }, null)).toBe(false);
    expect(filterSameWorkspace(rows, workspaceKeyOfRow({ _id: "j" }))).toEqual([]);
  });

  test("another member of T1 cannot reach the team-routed private row", () => {
    expect(inWorkspace(rows[2], activeWorkspaceKey("T1", "mate"))).toBe(false);
    expect(inWorkspace(rows[2], activeWorkspaceKey(null, "mate"))).toBe(false);
    expect(inWorkspace(rows[2], activeWorkspaceKey(null, "me"))).toBe(true);
  });
});
