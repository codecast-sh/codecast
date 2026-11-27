import { describe, expect, test } from "bun:test";
import { addPeople, addPerson, diffOwners, releaseParent, removePerson, removeRole, setParent, setRole, takeOverChange, type OwnersDraft } from "../ownersDraft";

const EVALS = { role_id: "r1", handle: "evals", name: "Eval Suite lead" };
const PEOPLE = { role_id: "r2", handle: "head-of-people", name: "Head of People" };
const start: OwnersDraft = { people: ["me"], role: null, parent: null };

describe("the owners menu's staged change", () => {
  test("one role at a time: adding a role replaces the one there", () => {
    const d = setRole(setRole(start, EVALS), PEOPLE);
    expect(d.role).toEqual(PEOPLE);
    expect(diffOwners(start, d).change).toEqual({ role: "r2" });
  });

  test("Select all adds each teammate once, after the owners already there", () => {
    const d = addPeople(addPerson(start, "ashot"), ["ashot", "armen", "armen", "me"]);
    expect(d.people).toEqual(["me", "ashot", "armen"]);
  });

  test("Save sends one change and its undo restores removed rows with their stamps", () => {
    const initial: OwnersDraft = { people: ["me", "ashot"], role: EVALS, parent: null };
    const d = removeRole(removePerson(addPerson(initial, "armen"), "ashot"));
    const diff = diffOwners(initial, d, { meId: "me", snapshots: [{ user_id: "ashot", added_by: "me", added_at: 5 }] });
    expect(diff.change).toEqual({ add: ["armen"], remove: ["ashot"], role: null });
    expect(diff.inverse).toEqual({ restore: [{ user_id: "ashot", added_by: "me", added_at: 5 }], remove: ["armen"], role: "r1" });
    expect(diff.dirty).toBe(true);
  });

  test("a leave alone is undone by adding yourself back", () => {
    const initial: OwnersDraft = { people: ["me", "ashot"], role: null, parent: null };
    const diff = diffOwners(initial, removePerson(initial, "me"), { meId: "me", snapshots: [{ user_id: "me", added_by: "me", added_at: 1 }] });
    expect(diff.leaving).toBe(true);
    expect(diff.inverse).toEqual({ add: ["me"] });
  });

  test("a leave with other changes has no undo unless you run the session", () => {
    const initial: OwnersDraft = { people: ["me", "ashot"], role: null, parent: null };
    const d = addPerson(removePerson(initial, "me"), "armen");
    expect(diffOwners(initial, d, { meId: "me" }).inverse).toBeNull();
    expect(diffOwners(initial, d, { meId: "me", meRuns: true }).inverse).toEqual({ add: ["me"], remove: ["armen"] });
  });

  test("releasing the parent session is undone by putting it back, and back again", () => {
    const initial: OwnersDraft = { people: ["me"], role: null, parent: "p1" };
    const diff = diffOwners(initial, releaseParent(initial));
    expect(diff.change).toEqual({ release_parent: true });
    expect(diff.inverse).toEqual({ restore_parent: true });
    const released: OwnersDraft = { people: ["me"], role: EVALS, parent: null };
    const back = diffOwners(released, setParent(released, "p1", { adopt: false }), { meId: "me", releasedParent: "p1" });
    expect(back.parentRestored).toBe(true);
    expect(back.change).toEqual({ restore_parent: true });
    expect(back.inverse).toEqual({ release_parent: true });
  });

  test("a session it never worked for is adopted: the role goes, a staying viewer is kept, undo detaches", () => {
    const peer: OwnersDraft = { people: ["me"], role: EVALS, parent: null };
    const diff = diffOwners(peer, setParent(peer, "spawner", { adopt: true }), { meId: "me", releasedParent: null });
    expect(diff.parentAdopted).toBe("spawner");
    expect(diff.change).toEqual({ add: ["me"], adopt_parent: "spawner" });
    expect(diff.inverse).toEqual({ role: "r1", detach_parent: true });
  });

  test("nothing staged is not dirty", () => {
    expect(diffOwners(start, start).dirty).toBe(false);
  });

  test("take it over: undo puts the role and the parent back and takes you off", () => {
    expect(takeOverChange({ people: [], role: EVALS, parent: null }, "me")).toEqual({ change: { take_over: true }, inverse: { role: "r1", remove: ["me"] } });
    expect(takeOverChange({ people: ["me"], role: EVALS, parent: null }, "me").inverse).toEqual({ role: "r1" });
    expect(takeOverChange({ people: [], role: null, parent: "p1" }, "me").inverse).toEqual({ restore_parent: true, remove: ["me"] });
    // A parent the viewer may not hand work to: the server would refuse putting it back, so no undo.
    expect(takeOverChange({ people: [], role: EVALS, parent: "p1" }, "me", { mayRestore: false }).inverse).toBeNull();
    const initial: OwnersDraft = { people: ["me"], role: null, parent: "p1" };
    expect(diffOwners(initial, releaseParent(initial), { mayRestore: false }).inverse).toBeNull();
  });
});
