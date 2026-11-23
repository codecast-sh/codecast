import { describe, expect, test } from "bun:test";
import { describeOwners, isRoleRef, namesFiledRole, ownersLine } from "./ownersView.js";

const ME = { user_id: "u1", name: "Jason Benn", email: "jason@x.ai" };
const MATE = { user_id: "u2", name: null, email: "ashot@x.ai" };
const ROLE = { role_id: "r1", short_id: "or-7", handle: "growth" };

describe("isRoleRef", () => {
  test("a handle or a role short id is a role; people and sessions are not", () => {
    expect(isRoleRef("@growth")).toBe(true);
    expect(isRoleRef("or-7")).toBe(true);
    expect(isRoleRef("ashot@x.ai")).toBe(false);
    expect(isRoleRef("Jason Benn")).toBe(false);
    expect(isRoleRef("jx7c6zk")).toBe(false);
  });
});

describe("namesFiledRole", () => {
  test("matches the filed role by handle, short id or id, and nothing else", () => {
    const read = { role: ROLE };
    expect(namesFiledRole(read, "@Growth")).toBe(true);
    expect(namesFiledRole(read, "or-7")).toBe(true);
    expect(namesFiledRole(read, "r1")).toBe(true);
    expect(namesFiledRole(read, "@billing")).toBe(false);
    expect(namesFiledRole({ role: null }, "@growth")).toBe(false);
  });
});

describe("describeOwners", () => {
  test("the role drives", () => {
    const d = describeOwners({ owners: [ME, MATE], role: ROLE, driver: { kind: "role", role_id: "r1" }, runner: { name: "Jason Benn" } });
    expect(d).toEqual({ people: "Jason Benn, ashot@x.ai", role: "@growth (drives)", runner: "Jason Benn" });
  });

  test("a person drives and the role is paused", () => {
    const d = describeOwners({ owners: [ME, MATE], role: ROLE, driver: { kind: "user", user_id: "u2" }, runner: { name: "Mr Bot", is_bot: true } });
    expect(d).toEqual({ people: "Jason Benn, ashot@x.ai (drives)", role: "@growth (paused: ashot@x.ai drives)", runner: "Mr Bot (agent account)" });
  });

  test("no owners reads as nobody, and the line drops a missing role", () => {
    expect(ownersLine({ owners: [], role: null, driver: null })).toBe("nobody");
    expect(ownersLine({ owners: [ME], role: ROLE, driver: { kind: "user", user_id: "u1" } })).toBe("Jason Benn (drives) · @growth (paused: Jason Benn drives)");
  });
});
