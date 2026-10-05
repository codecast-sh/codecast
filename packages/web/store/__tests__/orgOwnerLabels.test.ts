import { describe, expect, test } from "bun:test";
import type { UndoCtx } from "@platform/engine";
import { UNDO_SPECS } from "../undo/policy";

// Every owners-chip gesture lands in the timeline as one org entry. Its label
// says what was done, in the words the chip's own toast uses, not a generic
// "Moved in the org" that names none of it.
const S = "s".repeat(32);
const SAM = "m".repeat(32);
const ROLE = "r".repeat(32);
const before = {
  sessions: { [S]: { _id: S, title: "Fix the build" } },
  conversations: {},
  teamMembers: [{ _id: SAM, user_id: SAM, name: "Sam" }],
  currentUser: { _id: "me".padEnd(32, "e"), name: "Me" },
  orgTree: { roles: [{ _id: ROLE, name: "Infra lead" }] },
};
const label = (target: unknown) =>
  UNDO_SPECS.reparentOrgSession!.label({ action: "reparentOrgSession", args: [S, target], before, after: before, result: undefined, changes: [] } as UndoCtx);

describe("owner gestures name what they did", () => {
  test("hand off", () => expect(label({ kind: "user", owners: [SAM], mode: "set" })).toBe("Handed “Fix the build” off to Sam"));
  test("add an owner", () => expect(label({ kind: "user", owners: [SAM], mode: "add" })).toBe("Made Sam an owner of “Fix the build”"));
  test("remove an owner", () => expect(label({ kind: "user", owners: [SAM], mode: "remove" })).toBe("Removed Sam from “Fix the build”"));
  test("clear the owners", () => expect(label({ kind: "user", owners: [], mode: "set" })).toBe("Cleared the owners of “Fix the build”"));
  test("file under a role", () => expect(label({ kind: "role", role_id: ROLE })).toBe("Filed “Fix the build” under “Infra lead”"));
  test("a chart move under a person", () => expect(label({ kind: "user", user_id: SAM })).toBe("Moved “Fix the build” under Sam"));
});
