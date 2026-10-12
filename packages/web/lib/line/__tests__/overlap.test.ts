import { describe, expect, test } from "bun:test";
import { problemOverlaps, ruleOf, titleSimilarity, withDuplicatesUnderPrimary } from "../overlap";
import { takenWords } from "../lineModel";
import { closeChip } from "../scriptReport";

describe("overlap", () => {
  test("identical titles are one problem filed under the oldest; unlike titles stand alone", () => {
    const m = problemOverlaps([
      { id: "b", ref: "ct-2", title: "A message to a contact leads with the result", at: 2 },
      { id: "a", ref: "ct-1", title: "A message to a contact leads with the result", at: 1 },
      { id: "c", ref: "ct-3", title: "Fee answer invents transaction structure", at: 3 },
    ]);
    expect(m.get("b")).toMatchObject({ primary: "a", primaryRef: "ct-1", set: ["a", "b"] });
    expect(m.get("c")!.set).toEqual(["c"]);
    expect(withDuplicatesUnderPrimary([{ id: "c" }, { id: "b" }, { id: "a" }], m).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(titleSimilarity("Sender identity re-derived per send", "Fee model not disclosed")).toBe(0);
  });

  test("a rule is the expectation most findings cite", () => {
    expect(ruleOf(["moment:mo-1:ex-a-16", "moment:mo-2:ex-a-16", "evidence:x:ex-a-3"])).toBe("ex-a-16");
    expect(ruleOf(["moment:mo-1:ex-a-16", "evidence:x:ex-a-3"])).toBeNull();
  });
});

describe("taken edge words", () => {
  test("an or edge reads by the way the run took it, never the other", () => {
    const e = { condition: "outcome = success or prove.json.outcome = infeasible" };
    expect(takenWords(e, (lhs) => (lhs === "outcome" ? "success" : "red"))).toBeNull();
    expect(takenWords({ condition: "red.json.red = true or prove.json.outcome = infeasible" }, (lhs) => (lhs === "red.json.red" ? true : "red"))).toBe("red");
    expect(takenWords({ condition: "red.json.red = true or prove.json.outcome = infeasible" }, (lhs) => (lhs === "red.json.red" ? false : "infeasible"))).toBe("infeasible");
    expect(takenWords({ condition: "outcome = success" }, () => "success")).toBeUndefined();
  });
});

describe("close chip", () => {
  test("a dissolve says how it closed", () => {
    const v = (result: Record<string, unknown>) => [{ decided: { result } }];
    expect(closeChip(v({ outcome: "dissolved", kind: "already_fixed", into: "4a97f88114" }))).toBe("fixed on main 4a97f88");
    expect(closeChip(v({ kind: "known_cause", into: "ct-59229" }))).toBe("dup ct-59229");
    expect(closeChip(v({ kind: "judge_defect", into: "judge:comms" }))).toBe("judge defect");
    expect(closeChip(v({ outcome: "open" }))).toBeNull();
  });
});
