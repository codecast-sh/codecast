import { describe, expect, test } from "bun:test";
import { huddleWorkspace, huddleWorkspaceName } from "../huddleSettings";

// A huddle's workspace, as the banner, the auto-invite and the Scribe flow
// key it: one person's own huddle is their personal workspace even though
// the call bills to a team it borrowed (#299); any other is its team's.
describe("huddleWorkspace", () => {
  const teams = [{ _id: "t1", name: "Codecast" }];

  test("a team huddle is its team's", () => {
    const ws = huddleWorkspace("dm:me:you", { team_id: "t1", personal: false }, "me");
    expect(ws).toEqual({ key: "team:t1", teamId: "t1", personal: false });
    expect(huddleWorkspaceName(ws, teams)).toBe("Codecast");
  });

  test("the person's own huddle is Personal, whatever team it bills to", () => {
    const ws = huddleWorkspace("session:c1", { team_id: "t1", personal: true }, "me");
    expect(ws).toEqual({ key: "user:me", teamId: null, personal: true });
    expect(huddleWorkspaceName(ws, teams)).toBe("Personal");
  });

  test("a room of only me is Personal before its record loads", () => {
    expect(huddleWorkspace("dm:me", null, "me")).toEqual({ key: "user:me", teamId: null, personal: true });
  });

  test("nothing to key until the team or the viewer is known", () => {
    expect(huddleWorkspace("channel:c", null, "me")).toBeNull();
    expect(huddleWorkspace("dm:me", { team_id: "t1" }, null)).toBeNull();
  });
});
