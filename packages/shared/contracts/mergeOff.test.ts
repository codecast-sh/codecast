import { describe, expect, test } from "bun:test";
import { HANDED_EXIT, MERGE_OFF_REASON, handedRole, handedUnmerged, handedWords, mergeOffIn, mergeOffRole, roleMergeOffReason } from "./mergeOff";

describe("a merge switch that is off reads the same to every reader", () => {
  const role = roleMergeOffReason("release");
  test("the server's words, after a change stop, a line merge or a ship step", () => {
    for (const text of [role, `Stopped: ${role}`, `merge left to a person: ${role}`, `ship: no Requested-by\nnot merged: ${role}\nok Comment added`]) {
      expect([text, mergeOffIn(text), mergeOffRole(text)]).toEqual([text, true, "release"]);
    }
    // The words before roles had handles (an older server), and the line's.
    for (const text of [MERGE_OFF_REASON, `Stopped: ${MERGE_OFF_REASON}`, `merge left to a person: ${MERGE_OFF_REASON}`, "not merged: merge is off for this line; a person turns it on"]) {
      expect([text, mergeOffIn(text), mergeOffRole(text)]).toEqual([text, true, null]);
    }
  });
  test("other refusals, and the words merely quoted mid-line, are not", () => {
    for (const text of ["the role has reached its daily merge limit (2 of 2)", "Stopped: The reviewer rejected the change: says merge is off for this flow", ""]) expect(mergeOffIn(text)).toBe(false);
  });
  test("a change handed to its role", () => {
    expect(handedRole(handedWords("release", role))).toBe("release");
    expect(handedUnmerged({ status: "completed", current_node_id: HANDED_EXIT })).toBe(true);
    expect(handedUnmerged({ status: "completed", current_node_id: HANDED_EXIT, merge: { sha: "abc1234" } })).toBe(false);
    expect(handedUnmerged({ status: "failed", current_node_id: HANDED_EXIT })).toBe(false);
  });
});
