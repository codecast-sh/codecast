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
