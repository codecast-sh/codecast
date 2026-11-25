import { describe, expect, it } from "bun:test";
import { adminOfTeam, attendingOwnerId } from "../steering";

// The composer says Suggest exactly when the server would park the words
// (convex teamSuggestions.steeringOwnerFor): an owner is attending, and the
// viewer is neither an owner nor an admin of the session's team.

const CONV = { _id: "c1", user_id: "uRiley", team_id: "t1" };
const rileyHere = [{ _id: "uRiley", viewing_conversation_id: "c1", presence_state: "active" }];
const memberOfT1 = [{ _id: "t1", role: "member" }];
const adminOfT1 = [{ _id: "t1", role: "admin" }];

describe("attendingOwnerId", () => {
  it("a member suggests while the owner is attending", () => {
    expect(attendingOwnerId(rileyHere, CONV, "uJordan", memberOfT1)).toBe("uRiley");
  });

  it("an admin of the session's team sends", () => {
    expect(attendingOwnerId(rileyHere, CONV, "uAvery", adminOfT1)).toBeNull();
  });

  it("an admin of another team suggests like any member here", () => {
    expect(attendingOwnerId(rileyHere, CONV, "uAvery", [...memberOfT1, { _id: "t2", role: "admin" }])).toBe("uRiley");
  });

  it("nobody suggests when no owner is attending", () => {
    expect(attendingOwnerId([], CONV, "uJordan", memberOfT1)).toBeNull();
  });
});

describe("adminOfTeam", () => {
  it("reads the viewer's role in that team only", () => {
    expect(adminOfTeam(adminOfT1, "t1")).toBe(true);
    expect(adminOfTeam(memberOfT1, "t1")).toBe(false);
    expect(adminOfTeam(adminOfT1, "t2")).toBe(false);
    expect(adminOfTeam(adminOfT1, undefined)).toBe(false);
    expect(adminOfTeam(undefined, "t1")).toBe(false);
  });
});
