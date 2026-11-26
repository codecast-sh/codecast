// A session a folder rule shared (auto_shared) and its owner then made private
// must stop answering to its team everywhere: the conversation rule, the work
// items linked to it, and the patch every private writer applies.
import { describe, expect, test } from "bun:test";
import { teamVisibleConvTeam } from "@codecast/shared/contracts/managedPolicy";
import { computeWorkspaceKey } from "./lib/accessKeys";
import { PRIVATE_LOCK } from "./privacy";

const OWNER = "u".repeat(32) as any;
const TEAM = "t".repeat(32) as any;
const autoShared = { team_id: TEAM, is_private: false, auto_shared: true };

describe("a folder-shared session made private", () => {
  test("the private patch drops auto_shared and locks it", () => {
    expect(PRIVATE_LOCK).toEqual({ is_private: true, team_visibility: "private", auto_shared: undefined });
  });

  test("after the patch it answers to no team, and linked work stays the owner's", () => {
    const madePrivate = { ...autoShared, ...PRIVATE_LOCK };
    expect(teamVisibleConvTeam(madePrivate)).toBeUndefined();
    expect(computeWorkspaceKey({ user_id: OWNER, team_id: TEAM }, madePrivate)).toBe(`user:${OWNER}`);
  });

  test("a row made private before this fix (auto_shared still set) is private too", () => {
    const legacy = { team_id: TEAM, is_private: true, team_visibility: "private", auto_shared: true };
    expect(teamVisibleConvTeam(legacy)).toBeUndefined();
    expect(computeWorkspaceKey({ user_id: OWNER, team_id: TEAM }, legacy)).toBe(`user:${OWNER}`);
  });

  test("a shared session still answers to its team", () => {
    expect(teamVisibleConvTeam(autoShared)).toBe(TEAM);
    expect(computeWorkspaceKey({ user_id: OWNER }, autoShared)).toBe(`team:${TEAM}`);
    expect(teamVisibleConvTeam({ team_id: TEAM, is_private: true, team_visibility: "full" })).toBe(TEAM);
  });
});
