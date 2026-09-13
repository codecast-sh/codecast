import { describe, expect, test } from "bun:test";
import { matchOrgTarget } from "./orgTarget";

const tree = {
  roles: [{ _id: "org_roles_abc", short_id: "or-3", handle: "growth" }],
  people: [{ user_id: "users_me", name: "Me", is_me: true }, { user_id: "users_mate", name: "Mate" }],
};

describe("matchOrgTarget", () => {
  test("a short id resolves to the role's real id, never travels as or-N", () => {
    expect(matchOrgTarget(tree, "or-3")).toEqual({ kind: "role", role_id: "org_roles_abc" });
  });
  test("@handle and raw id resolve the same role", () => {
    expect(matchOrgTarget(tree, "@Growth")).toEqual({ kind: "role", role_id: "org_roles_abc" });
    expect(matchOrgTarget(tree, "org_roles_abc")).toEqual({ kind: "role", role_id: "org_roles_abc" });
  });
  test("people by name, id, or me", () => {
    expect(matchOrgTarget(tree, "mate")).toEqual({ kind: "user", user_id: "users_mate" });
    expect(matchOrgTarget(tree, "users_mate")).toEqual({ kind: "user", user_id: "users_mate" });
    expect(matchOrgTarget(tree, "me")).toEqual({ kind: "user", user_id: "users_me" });
  });
  test("unknown ref and missing tree return null", () => {
    expect(matchOrgTarget(tree, "or-99")).toBeNull();
    expect(matchOrgTarget(null, "me")).toBeNull();
  });
});
