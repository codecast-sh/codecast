import { describe, expect, test } from "bun:test";
import { escalationTargetIds } from "./decisionEscalation";

const members = [
  { user_id: "owner", role: "admin" },
  { user_id: "mgr", role: "member" },
  { user_id: "admin", role: "admin" },
  { user_id: "bot", role: "admin", is_bot: true },
];

describe("who an escalation reaches", () => {
  test("the owner's manager", () => {
    expect(escalationTargetIds("owner", "mgr", members)).toEqual(["mgr"]);
  });

  test("a manager who is a bot or not a member falls back to the admins", () => {
    expect(escalationTargetIds("owner", "bot", members)).toEqual(["admin"]);
    expect(escalationTargetIds("owner", "stranger", members)).toEqual(["admin"]);
  });

  test("no manager: the admins who are people, without the owner", () => {
    expect(escalationTargetIds("owner", null, members)).toEqual(["admin"]);
    expect(escalationTargetIds("owner", "owner", members)).toEqual(["admin"]);
  });

  test("never the person escalating: an admin escalating a teammate's decision reaches the other admins", () => {
    const team = [...members, { user_id: "admin2", role: "admin" }];
    expect(escalationTargetIds("mgr", null, team, "admin")).toEqual(["owner", "admin2"]);
    expect(escalationTargetIds("owner", "mgr", members, "mgr")).toEqual(["admin"]);
    expect(escalationTargetIds("mgr", null, [{ user_id: "mgr" }, { user_id: "admin", role: "admin" }], "admin")).toEqual([]);
  });

  test("nobody above the owner", () => {
    expect(escalationTargetIds("owner", undefined, [{ user_id: "owner", role: "admin" }, { user_id: "bot", role: "admin", is_bot: true }])).toEqual([]);
  });
});
