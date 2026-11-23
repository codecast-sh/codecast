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
  test("the role is active", () => {
    const d = describeOwners({ owners: [ME, MATE], role: ROLE, driver: { kind: "role", role_id: "r1" }, runner: { name: "Jason Benn" } });
    expect(d).toEqual({ people: "Jason Benn, ashot@x.ai", role: "@growth (active)", runner: "Jason Benn" });
  });

  test("a person works in it and the role is paused; no person is marked", () => {
    const d = describeOwners({ owners: [ME, MATE], role: ROLE, driver: { kind: "user", user_id: "u2" }, runner: { name: "Mr Bot", is_bot: true } });
    expect(d).toEqual({ people: "Jason Benn, ashot@x.ai", role: "@growth (paused)", runner: "Mr Bot (agent account)" });
  });

  test("no owners reads as nobody, and the line drops a missing role", () => {
    expect(ownersLine({ owners: [], role: null, driver: null })).toBe("nobody");
    expect(ownersLine({ owners: [ME], role: ROLE, driver: { kind: "user", user_id: "u1" } })).toBe("Jason Benn · @growth (paused)");
  });

  test("never says drives", () => {
    for (const driver of [{ kind: "role" as const, role_id: "r1" }, { kind: "user" as const, user_id: "u1" }, null]) {
      expect(ownersLine({ owners: [ME, MATE], role: ROLE, driver })).not.toMatch(/driv/i);
    }
  });
});
