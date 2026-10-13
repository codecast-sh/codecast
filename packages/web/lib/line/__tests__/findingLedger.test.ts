// "Not this problem" (ct-58022: its only finding is a contact asking to be removed, not a call outside hours).
import { describe, expect, test } from "bun:test";
import { assertGlance } from "../../../components/consequential/__tests__/glance";
import { moveFindingLedger } from "../findingLedger";

describe("moveFindingLedger", () => {
  test("a problem's only finding: the review says it leaves the problem with none", () => {
    const l = moveFindingLedger({ problem: "ct-58022", count: 1, left: 0 });
    assertGlance(l);
    expect(l).toMatchObject({ name: "Not this problem", confirm: "Move it out", alert: "Leaves it with none" });
  });
  test("a finding whose key holds more says how many leave with it", () => {
    const l = moveFindingLedger({ problem: "ct-57459", count: 32, left: 15 });
    assertGlance(l);
    expect(l.confirm).toBe("Move 32 out");
    expect(l.figures.map((f) => f.value)).toEqual(["32", "15"]);
    expect(l.alert).toBeUndefined();
  });
});

describe("askCauseLedger", () => {
  const { askCauseLedger } = require("../findingLedger") as typeof import("../findingLedger");
  test("a group of asks files as one new problem, or into the open problem its filed asks are on; every word a glance", () => {
    const fresh = askCauseLedger({ cause: "No phone on file and email pitch unanswered", unfiled: ["Matthew Ca", "Philippe Cote-Leger"], filed: 0 });
    expect(fresh.confirm).toBe("File 2 as one problem");
    expect(fresh.figures.map((f) => `${f.value} ${f.label}`)).toEqual(["2 asks filed", "1 new problem"]);
    const into = askCauseLedger({ cause: "Email ceiling and no phone on file", unfiled: ["A", "B", "C", "D", "E", "F", "G"], filed: 3, into: "ct-57442" });
    expect(into.name).toBe("File into ct-57442");
    expect(into.confirm).toBe("File 7 into ct-57442");
    expect(into.rows.find((r) => r.k === "Already filed")?.v).toBe("3 on ct-57442");
    for (const l of [fresh, into]) assertGlance(l);
  });
});
