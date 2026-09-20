import { describe, expect, it } from "bun:test";
import { rolesAndPeopleOptions } from "../assigneeOptions";

// org-roles-run-work.md R5: pickers list roles with people, under "Roles" and
// "People". A role's seat is a bot user on the roster named after the role;
// it is never a person to pick, and the rule needs no org tree.
const people = [
  { _id: "u1", name: "Jason", github_username: "jbenn" },
  { _id: "bot1", name: "Growth", is_bot: true },
  { _id: "u2", name: "Ashot", github_username: "ashot" },
];
const roles = [
  { _id: "r1", short_id: "or-1", name: "Growth", handle: "growth", avatar: "fox", status: "active" },
  { _id: "r2", short_id: "or-2", name: "Old", handle: "old", avatar: "owl", status: "retired" },
];

describe("rolesAndPeopleOptions", () => {
  it("a bot on the roster is not a person, with or without the org tree", () => {
    const cold = rolesAndPeopleOptions(people, []);
    expect(cold.people.map((p) => p.key)).toEqual(["u1", "u2"]);
    expect(cold.roles).toEqual([]);
    // Alone, people carry no heading; with roles, both lists do.
    expect(cold.people.every((p) => p.section === undefined)).toBe(true);
    const warm = rolesAndPeopleOptions(people, roles);
    expect(warm.people.map((p) => [p.key, p.section])).toEqual([["u1", "People"], ["u2", "People"]]);
  });

  it("live roles are listed under Roles with their handle and the contract's info; retired ones are not", () => {
    const { roles: out } = rolesAndPeopleOptions(people, roles);
    expect(out.map((r) => [r.key, r.label, r.hint, r.section])).toEqual([["r1", "Growth", "@growth", "Roles"]]);
    expect(out[0].info).toMatchObject({ kind: "role", handle: "growth", role_short_id: "or-1" });
  });

  it("a person's info is the shape every surface draws", () => {
    const { people: out } = rolesAndPeopleOptions(people, roles);
    expect(out[0].info).toEqual({ name: "Jason", image: undefined, github_username: "jbenn" });
  });
});
