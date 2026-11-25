import { describe, expect, test } from "bun:test";
import { relatedOpenDecisions } from "../decisionQueue";

// ct-101357: which open decisions on the same subject a card points at.
const ME = "u_me";
const mine = { _id: "d1", task_id: "t1", status: "pending", asked_user_ids: [ME], in_queue: true };
const theirs = { _id: "d2", short_id: "sd-2", task_id: "t2", status: "pending", asked_user_ids: ["u_mate"], in_queue: false };
const tasks = (t1: object = {}, t2: object = {}) => ({
  t1: { short_id: "ct-1", ...t1 },
  t2: { short_id: "ct-2", ...t2 },
});
const ids = (decisions: Record<string, any>, t: Record<string, any>) => relatedOpenDecisions(decisions.d1, decisions, t, ME).map((d) => d._id);

describe("relatedOpenDecisions", () => {
  test("a teammate's open decision on a related task, linked from either side", () => {
    expect(ids({ d1: mine, d2: theirs }, tasks({ related: ["ct-2"] }))).toEqual(["d2"]);
    expect(ids({ d1: mine, d2: theirs }, tasks({}, { related: ["ct-1"] }))).toEqual(["d2"]);
  });
  test("duplicate and superseded links count in either direction", () => {
    expect(ids({ d1: mine, d2: theirs }, tasks({ duplicate_of: "ct-2" }))).toEqual(["d2"]);
    expect(ids({ d1: mine, d2: theirs }, tasks({}, { superseded_by: "ct-1" }))).toEqual(["d2"]);
  });
  test("another open decision on the same task", () => {
    expect(ids({ d1: mine, d2: { ...theirs, task_id: "t1" } }, tasks())).toEqual(["d2"]);
  });
  test("nothing for an unlinked task", () => {
    expect(ids({ d1: mine, d2: theirs }, tasks())).toEqual([]);
  });
  test("nothing once the other is answered, withdrawn or cancelled", () => {
    for (const status of ["answered", "withdrawn", "cancelled"]) {
      expect(ids({ d1: mine, d2: { ...theirs, status } }, tasks({ related: ["ct-2"] }))).toEqual([]);
    }
  });
  test("nothing when the other is already in the viewer's stepper", () => {
    expect(ids({ d1: mine, d2: { ...theirs, asked_user_ids: [ME], in_queue: true } }, tasks({ related: ["ct-2"] }))).toEqual([]);
  });
  test("nothing when the decision or its task is not in the store", () => {
    expect(relatedOpenDecisions(undefined, { d2: theirs }, tasks({ related: ["ct-2"] }), ME)).toEqual([]);
    expect(ids({ d1: { ...mine, task_id: undefined }, d2: theirs }, tasks({ related: ["ct-2"] }))).toEqual([]);
    expect(ids({ d1: mine, d2: theirs }, {})).toEqual([]);
  });
});
