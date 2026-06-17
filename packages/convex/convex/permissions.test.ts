import { describe, expect, test } from "bun:test";
import { canAccessResourceForUser } from "./permissions";

const userA = "user_a" as any;
const userB = "user_b" as any;
const teamA = "team_a" as any;
const teamB = "team_b" as any;
const conversationA = "conversation_a" as any;

const record = (over: Record<string, any> = {}) => ({
  _id: "record_a" as any,
  user_id: userA,
  ...over,
});

describe("canAccessResourceForUser", () => {
  test("allows the owner", () => {
    expect(canAccessResourceForUser({ record: record(), userId: userA })).toBe(true);
  });

  test("rejects another user for a personal record", () => {
    expect(canAccessResourceForUser({ record: record(), userId: userB })).toBe(false);
  });

  test("allows a member of the resource team", () => {
    expect(canAccessResourceForUser({
      record: record({ team_id: teamA }),
      userId: userB,
      teamMembershipIds: [teamA],
    })).toBe(true);
  });

  test("rejects nonmembers of the resource team", () => {
    expect(canAccessResourceForUser({
      record: record({ team_id: teamA }),
      userId: userB,
      teamMembershipIds: [teamB],
    })).toBe(false);
  });

  test("allows team access inherited from a visible linked conversation", () => {
    const convMap = new Map<string, any>([
      [conversationA, { team_id: teamA, is_private: false }],
    ]);

    expect(canAccessResourceForUser({
      record: record({ conversation_id: conversationA }),
      userId: userB,
      teamMembershipIds: [teamA],
      convMap,
    })).toBe(true);
  });

  test("does not expose records from private linked conversations to team members", () => {
    const convMap = new Map<string, any>([
      [conversationA, { team_id: teamA, is_private: true, team_visibility: "private" }],
    ]);

    expect(canAccessResourceForUser({
      record: record({ conversation_id: conversationA, team_id: teamA }),
      userId: userB,
      teamMembershipIds: [teamA],
      convMap,
    })).toBe(false);
  });
});
