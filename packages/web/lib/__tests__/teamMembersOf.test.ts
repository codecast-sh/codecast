import { describe, expect, test } from "bun:test";
import { teamMembersOf } from "../activeTeam";

const state = (team: string | undefined, teamMembers: any[]) => ({ clientState: { ui: { active_team_id: team } }, teamMembers });

describe("teamMembersOf", () => {
  const roster = [{ _id: "u1", roster_team: "T1" }, { _id: "u2", roster_team: "T1" }];

  test("personal workspace reads no one", () => {
    expect(teamMembersOf(state(undefined, roster))).toEqual([]);
  });

  test("another team's held roster reads no one", () => {
    expect(teamMembersOf(state("T2", roster))).toEqual([]);
  });

  test("the active team's roster is the store's own array", () => {
    expect(teamMembersOf(state("T1", roster))).toBe(roster);
  });

  test("mixed rows keep only the active team's", () => {
    const mixed = [{ _id: "a", roster_team: "T1" }, { _id: "b", roster_team: "T2" }, { _id: "c" }];
    expect(teamMembersOf(state("T1", mixed)).map((m) => m._id)).toEqual(["a"]);
    expect(teamMembersOf(state("T2", mixed)).map((m) => m._id)).toEqual(["b"]);
  });

  test("the answer is stable across calls", () => {
    const mixed = [{ _id: "a", roster_team: "T1" }, { _id: "b", roster_team: "T2" }];
    const s = state("T1", mixed);
    expect(teamMembersOf(s)).toBe(teamMembersOf(s));
    expect(teamMembersOf(state("T1", mixed))).toBe(teamMembersOf(s));
    expect(teamMembersOf(state(undefined, mixed))).toBe(teamMembersOf(state("T9", roster)));
  });

  test("missing roster or state reads no one", () => {
    expect(teamMembersOf(undefined)).toEqual([]);
    expect(teamMembersOf({ clientState: { ui: { active_team_id: "T1" } } })).toEqual([]);
  });
});
