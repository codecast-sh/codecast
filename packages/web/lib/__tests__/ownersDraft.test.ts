import { describe, expect, test } from "bun:test";
import { addPerson, addRole, diffOwners, leave, removePerson, removeRole, type OwnersDraft } from "../ownersDraft";

const EVALS = { role_id: "r1", short_id: "or-1", handle: "evals", name: "Eval Suite lead", avatar: null };
const GROWTH = { role_id: "r2", short_id: "or-2", handle: "growth", name: "Growth", avatar: null };
const justMe: OwnersDraft = { ownerIds: ["me"], role: null, driver: { kind: "user", user_id: "me" }, moveTo: null };

describe("the owners menu's staged change", () => {
  test("no edits, no change", () => {
    expect(diffOwners(justMe, justMe)).toMatchObject({ dirty: false, change: {} });
  });

  test("adding a role makes it drive; Save sends only the role", () => {
    const d = addRole(justMe, EVALS);
    expect(d.driver).toEqual({ kind: "role", role_id: "r1" });
    const { change, undo } = diffOwners(justMe, d);
    expect(change).toEqual({ role: "r1", driver: { kind: "role" } });
    expect(undo).toEqual({ role: null, driver: { kind: "user", user_id: "me" } });
  });

  test("one role at a time: a second role replaces the first", () => {
    const d = addRole(addRole(justMe, EVALS), GROWTH);
    expect(d.role?.role_id).toBe("r2");
    expect(diffOwners(justMe, d).change.role).toBe("r2");
  });

  test("a person made driver after adding a role pauses it, so the driver is sent after the role", () => {
    const d = { ...addRole(justMe, EVALS), driver: { kind: "user" as const, user_id: "me" } };
    expect(diffOwners(justMe, d).change).toEqual({ role: "r1", driver: { kind: "user", user_id: "me" } });
  });

  test("adding a teammate keeps the driver; Make driver on a candidate adds and drives", () => {
    expect(diffOwners(justMe, addPerson(justMe, "ashot")).change).toEqual({ add: ["ashot"] });
    expect(diffOwners(justMe, addPerson(justMe, "ashot", true)).change).toEqual({ add: ["ashot"], driver: { kind: "user", user_id: "ashot" } });
  });

  test("removing the driver hands the wheel to the role, else the first person left", () => {
    const withRole: OwnersDraft = { ownerIds: ["me", "ashot"], role: EVALS, driver: { kind: "user", user_id: "me" }, moveTo: null };
    expect(removePerson(withRole, "me").driver).toEqual({ kind: "role", role_id: "r1" });
    const roleDrives: OwnersDraft = { ...withRole, driver: { kind: "role", role_id: "r1" } };
    expect(removeRole(roleDrives).driver).toEqual({ kind: "user", user_id: "me" });
  });

  test("leaving moves the session first and takes you off", () => {
    const two: OwnersDraft = { ownerIds: ["me", "ashot"], role: null, driver: { kind: "user", user_id: "ashot" }, moveTo: null };
    const d = leave(two, "me", { device_id: "mini", is_remote: false, label: "Ashot's Mac mini" });
    const { change, undo, dirty } = diffOwners(two, d);
    expect(dirty).toBe(true);
    expect(d.moveTo?.device_id).toBe("mini");
    expect(change).toEqual({ remove: ["me"] });
    expect(undo).toEqual({ add: ["me"], driver: { kind: "user", user_id: "ashot" } });
  });
});
