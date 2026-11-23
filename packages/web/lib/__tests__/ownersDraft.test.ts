import { describe, expect, test } from "bun:test";
import { addPeople, addPerson, addRole, diffOwners, leave, removePerson, removeRole, teamMoveTargets, type OwnersDraft } from "../ownersDraft";

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
    const { change, inverse } = diffOwners(justMe, d);
    expect(change).toEqual({ role: "r1", driver: { kind: "role" } });
    // The driver nobody chose comes back unset, not stamped as "me".
    expect(inverse).toEqual({ role: null, driver: { kind: "none" } });
    // A driver someone did choose comes back as that person.
    expect(diffOwners(justMe, d, { initialDriverUserId: "me" }).inverse?.driver).toEqual({ kind: "user", user_id: "me" });
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

  test("leaving rides the change with its move, and is undone by rejoining", () => {
    const two: OwnersDraft = { ownerIds: ["me", "ashot"], role: null, driver: { kind: "user", user_id: "ashot" }, moveTo: null };
    const d = leave(two, "me", { device_id: "mini", is_remote: false, label: "Ashot's Mac mini", runner_id: "ashot", runner_is_bot: false });
    const { change, inverse, dirty } = diffOwners(two, d, { meId: "me" });
    expect(dirty).toBe(true);
    expect(change).toEqual({ leave: { move_to_device_id: "mini", runner_id: "ashot", runner_is_bot: false } });
    // Rejoin: the session stays on the machine it moved to.
    expect(inverse).toEqual({ add: ["me"] });
  });

  test("leaving a teammate's session needs no move, and is undone by rejoining", () => {
    const two: OwnersDraft = { ownerIds: ["ashot", "me"], role: null, driver: { kind: "user", user_id: "ashot" }, moveTo: null };
    const { change, inverse } = diffOwners(two, leave(two, "me", null), { meId: "me" });
    expect(change).toEqual({ leave: {} });
    expect(inverse).toEqual({ add: ["me"] });
  });

  test("a leave with other changes has no undo: who left may not edit the rest", () => {
    const three: OwnersDraft = { ownerIds: ["ashot", "me", "sam"], role: null, driver: { kind: "user", user_id: "ashot" }, moveTo: null };
    const { inverse } = diffOwners(three, leave(removePerson(three, "sam"), "me", null), { meId: "me" });
    expect(inverse).toBeNull();
  });

  test("undo of a remove puts the row back in its place", () => {
    const three: OwnersDraft = { ownerIds: ["me", "ashot", "sam"], role: null, driver: { kind: "user", user_id: "me" }, moveTo: null };
    const snap = { user_id: "ashot", added_at: 2, added_by: "me" };
    const { change, inverse } = diffOwners(three, removePerson(three, "ashot"), { meId: "me", snapshots: [snap] });
    expect(change).toEqual({ remove: ["ashot"] });
    expect(inverse).toEqual({ restore: [snap] });
  });
});

describe("Select all teammates", () => {
  test("adds every teammate not yet an owner as a pending owner, never the driver or the role", () => {
    const start: OwnersDraft = { ownerIds: ["me", "ashot"], role: EVALS, driver: { kind: "role", role_id: "r1" }, moveTo: null };
    const d = addPeople(start, ["ashot", "sam", "cam", "sam"]);
    expect(d.ownerIds).toEqual(["me", "ashot", "sam", "cam"]);
    expect(d.driver).toEqual(start.driver);
    expect(d.role).toBe(EVALS);
    expect(diffOwners(start, d).change).toEqual({ add: ["sam", "cam"] });
  });

  test("everyone already an owner changes nothing", () => {
    expect(addPeople(justMe, ["me"])).toBe(justMe);
  });
});

test("a leave moves a session only to a team machine that is not yours and not a cloud box", () => {
  const own = [{ device_id: "laptop" }];
  const boxes = [{ device_id: "laptop" }, { device_id: "mr-bot" }, { device_id: "cloud", is_remote: true }];
  expect(teamMoveTargets(own, boxes).map((b) => b.device_id)).toEqual(["mr-bot"]);
  expect(teamMoveTargets(own, null)).toEqual([]);
});
