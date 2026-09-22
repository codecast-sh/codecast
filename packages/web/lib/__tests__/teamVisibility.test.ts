import { describe, expect, test } from "bun:test";
import {
  describePinnedPast,
  pickTeamSharingNudge,
  teamVisibilityFor,
  teamVisibilityOption,
  TEAM_VISIBILITY_OPTIONS,
} from "../teamVisibility";

// The share-in-full nudge names one team and only when the click would change
// something someone sees: another person is on the team, a project flows to
// it, and the member shows less than the whole conversation.
describe("pickTeamSharingNudge", () => {
  const solo = { _id: "t_solo", name: "Solo", visibility: "summary", member_count: 1, shared_project_count: 2 };
  const unshared = { _id: "t_unshared", name: "Unshared", visibility: "summary", member_count: 4, shared_project_count: 0 };
  const alreadyFull = { _id: "t_full", name: "Full", visibility: "full", member_count: 3, shared_project_count: 1 };
  const worth = { _id: "t_worth", name: "Worth", visibility: "summary", member_count: 3, shared_project_count: 1 };

  test("skips teams with nobody else, nothing shared, or already full", () => {
    expect(pickTeamSharingNudge([solo, unshared, alreadyFull])).toBeNull();
  });

  test("returns the first team worth nudging about", () => {
    expect(pickTeamSharingNudge([solo, worth, { ...worth, _id: "t_later" }])?._id).toBe("t_worth");
  });

  test("a hidden or activity-only level counts as below full", () => {
    expect(pickTeamSharingNudge([{ ...worth, visibility: "hidden" }])?._id).toBe("t_worth");
    expect(pickTeamSharingNudge([{ ...worth, visibility: "activity" }])?._id).toBe("t_worth");
  });

  test("tolerates an empty list and null rows", () => {
    expect(pickTeamSharingNudge(null)).toBeNull();
    expect(pickTeamSharingNudge([null as any, worth])?._id).toBe("t_worth");
  });
});

describe("level copy", () => {
  test("every level has a label, what teammates see, and a detail sentence", () => {
    expect(TEAM_VISIBILITY_OPTIONS.map((o) => o.value)).toEqual(["hidden", "activity", "summary", "full"]);
    for (const o of TEAM_VISIBILITY_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.sees.length).toBeGreaterThan(0);
      expect(o.detail.endsWith(".")).toBe(true);
    }
  });

  test("an unknown level reads as summary, the server default", () => {
    expect(teamVisibilityOption(undefined).value).toBe("summary");
    expect(teamVisibilityOption("bogus").value).toBe("summary");
  });

  test("teamVisibilityFor matches by id as a string", () => {
    const teams = [{ _id: "t1", name: "One", visibility: "full" }];
    expect(teamVisibilityFor(teams, "t1")?.name).toBe("One");
    expect(teamVisibilityFor(teams, "t2")).toBeNull();
    expect(teamVisibilityFor(teams, null)).toBeNull();
  });
});

describe("describePinnedPast", () => {
  const sep22 = new Date(2026, 8, 22).getTime();
  const sep1 = new Date(2026, 8, 1).getTime();

  test("nothing pinned reads as an empty line", () => {
    expect(describePinnedPast({ visibility: "full" })).toBe("");
    expect(describePinnedPast({ visibility: "full", visibility_history: [] })).toBe("");
  });

  test("one segment names the boundary and the pinned level", () => {
    const line = describePinnedPast({ visibility: "full", visibility_history: [{ before: sep22, visibility: "summary" }] });
    expect(line).toBe(`Sessions before ${new Date(sep22).toLocaleDateString(undefined, { month: "short", day: "numeric" })} stay at Summary.`);
  });

  test("several segments list each level with its window", () => {
    const line = describePinnedPast({
      visibility: "full",
      visibility_history: [{ before: sep1, visibility: "hidden" }, { before: sep22, visibility: "summary" }],
    });
    expect(line.startsWith("Older sessions stay lower: Hidden until ")).toBe(true);
    expect(line).toContain("Summary from ");
  });
});
