import { describe, expect, it } from "bun:test";
import { adminOfTeam, answerRoles, attendingOwnerId } from "../steering";

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

// Who answers the session's questions and prompts, the client's copy of the
// server (commandsSession, teamSuggestions.adminAnswers, viewerSeesDetail).
describe("answerRoles", () => {
  const id = (c: string) => c.repeat(32);
  const RILEY = id("r"), SAM = id("s"), AVERY = id("a"), JORDAN = id("j");
  // Riley runs it; Sam is its primary owner; shared with team t1 in full.
  const session = (extra: Record<string, unknown> = {}) => ({
    _id: id("c"), user_id: RILEY, owner_user_id: SAM, team_id: "t1", access_level: "team", ...extra,
  });
  const roles = (me: string, teams: any[], extra: Record<string, unknown> = {}) => {
    const r = answerRoles(session(extra) as any, me, teams);
    return [r.canAnswer, r.proposalRole, r.permissionRole, r.allowAll];
  };

  it("the runner answers everything and may Allow all", () => {
    expect(roles(RILEY, memberOfT1, { access_level: "owner" })).toEqual([true, "owner", "runner", true]);
  });

  it("the primary owner answers questions and proposes on prompts, as before", () => {
    expect(roles(SAM, memberOfT1, { access_level: "owner" })).toEqual([true, "owner", "proposer", true]);
  });

  it("an admin answers questions and prompts directly, with no Allow all", () => {
    expect(roles(AVERY, adminOfT1)).toEqual([true, null, "admin", false]);
  });

  it("an admin who is also an assigned (not primary) owner gets the same, still no Allow all", () => {
    expect(roles(AVERY, adminOfT1, { access_level: "owner" })).toEqual([true, null, "admin", false]);
  });

  it("a member proposes", () => {
    expect(roles(JORDAN, memberOfT1)).toEqual([false, "teammate", "proposer", false]);
  });

  it("an admin of another team proposes like a member", () => {
    expect(roles(AVERY, [...memberOfT1, { _id: "t2", role: "admin" }])).toEqual([false, "teammate", "proposer", false]);
  });

  it("an admin is a plain teammate on a hosted agent or a role's standing session", () => {
    expect(roles(AVERY, adminOfT1, { agent_type: "codecast" })).toEqual([false, "teammate", "proposer", false]);
    expect(roles(AVERY, adminOfT1, { standing_role_id: "role1" })).toEqual([false, "teammate", "proposer", false]);
  });

  it("an admin who reads only a summary, or only through a share link, answers nothing", () => {
    expect(roles(AVERY, adminOfT1, { team_visibility: "summary" })).toEqual([false, null, "proposer", false]);
    expect(roles(AVERY, adminOfT1, { access_level: "shared" })).toEqual([false, null, "proposer", false]);
  });
});
