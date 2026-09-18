import { describe, expect, test } from "bun:test";
import { chainAssignees, chainHeadOf, isRoleAssignee, roleAssigneeInfo, rolesInChainOf, sameAssigneeInfo } from "./orgAssignee";
import { defaultAvatarFor } from "./orgAvatars";

const user = (id: string) => ({ kind: "user" as const, user_id: id });
const under = (id: string) => ({ kind: "role" as const, role_id: id });

const roles = [
  { _id: "growth", status: "active", reports_to: user("ashot") },
  { _id: "ads", status: "active", reports_to: under("growth") },
  { _id: "seo", status: "active", reports_to: under("growth") },
  { _id: "platform", status: "active", reports_to: user("samvit") },
  { _id: "old", status: "retired", reports_to: user("ashot") },
];

describe("roleAssigneeInfo", () => {
  test("a role resolves to a face, a name and a handle", () => {
    const info = roleAssigneeInfo({ _id: "growth", short_id: "or-8", name: "Head of Growth", handle: "growth", avatar: "fox" });
    expect(info).toEqual({ kind: "role", name: "Head of Growth", handle: "growth", avatar: "fox", role_id: "growth", role_short_id: "or-8" });
    expect(isRoleAssignee(info)).toBe(true);
  });

  test("a role that never chose a face wears the default for its handle", () => {
    expect(roleAssigneeInfo({ _id: "x", short_id: "or-1", name: "X", handle: "growth" }).avatar).toBe(defaultAvatarFor("growth"));
  });

  test("a person is not a role", () => {
    expect(isRoleAssignee({ name: "Ashot" } as any)).toBe(false);
    expect(isRoleAssignee(null)).toBe(false);
  });
});

describe("sameAssigneeInfo", () => {
  test("two derives of one role are equal, so an unchanged row keeps its ref", () => {
    const role = { _id: "growth", short_id: "or-8", name: "Head of Growth", handle: "growth" };
    expect(sameAssigneeInfo(roleAssigneeInfo(role), roleAssigneeInfo(role))).toBe(true);
  });

  test("a role and a person with the same name differ", () => {
    const role = roleAssigneeInfo({ _id: "growth", short_id: "or-8", name: "Growth", handle: "growth" });
    expect(sameAssigneeInfo(role, { name: "Growth" })).toBe(false);
  });

  test("a rename shows", () => {
    const a = roleAssigneeInfo({ _id: "growth", short_id: "or-8", name: "Growth", handle: "growth" });
    const b = roleAssigneeInfo({ _id: "growth", short_id: "or-8", name: "Head of Growth", handle: "growth" });
    expect(sameAssigneeInfo(a, b)).toBe(false);
  });
});

describe("the reporting chain", () => {
  test("a role's chain ends at the person above it, at any depth", () => {
    expect(chainHeadOf("growth", roles)).toBe("ashot");
    expect(chainHeadOf("ads", roles)).toBe("ashot");
    expect(chainHeadOf("platform", roles)).toBe("samvit");
  });

  test("a missing parent or a cycle ends nowhere", () => {
    expect(chainHeadOf("orphan", [{ _id: "orphan", reports_to: under("gone") }])).toBeNull();
    const loop = [{ _id: "a", reports_to: under("b") }, { _id: "b", reports_to: under("a") }];
    expect(chainHeadOf("a", loop)).toBeNull();
  });

  test("a person's chain is themselves, then their roles, parents first, retired left out", () => {
    expect(rolesInChainOf("ashot", roles).map((r) => r._id)).toEqual(["growth", "ads", "seo"]);
    expect(chainAssignees("ashot", roles)).toEqual(["ashot", "growth", "ads", "seo"]);
    expect(chainAssignees("samvit", roles)).toEqual(["samvit", "platform"]);
    expect(chainAssignees("nobody", roles)).toEqual(["nobody"]);
  });
});
