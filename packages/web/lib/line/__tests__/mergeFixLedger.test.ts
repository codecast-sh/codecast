// The review of landing an approved fix (MergeFixAct): facts at a glance, and a
// confirm that names what will really happen (ct-57509: merge step off; ct-58282: nobody answered).
import { describe, expect, test } from "bun:test";
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import { assertGlance } from "../../../components/consequential/__tests__/glance";
import { fixActName, mergeFixLedger } from "../mergeFixLedger";

const plan = (o: Partial<ShipPlan> = {}): ShipPlan => ({
  procedure: "cast_ship", target: { kind: "task", id: "t1" }, label: "ct-57509", decisionId: null, branch: "codecast/line-ct-57509", newBranch: false, base: "main",
  checks: ["cast ws check"], command: null, pr: { action: "open" }, merge: { will: false, method: "squash", why: "", via: null }, steps: [], blocked: null, ...o,
});
const change = { files: 3, added: 108, removed: 1, pr: null };

describe("mergeFixLedger", () => {
  test("where the line will not merge, the press opens a pull request with no alarm, and says the merge is a person's there", () => {
    const l = mergeFixLedger({ problem: "ct-57509 · The call gate blocks David Wang", plan: plan(), change, approved: "sd-583 · Oct 12", prNumber: null });
    assertGlance(l);
    expect(l).toMatchObject({ name: "Open its pull request", confirm: "Open pull request", blocked: undefined });
    expect(l.alert).toBeUndefined();
    expect(l.rows.find((r) => r.k === "Merges")?.v).toBe("A person, on the pull request");
    expect(l.rows.find((r) => r.k === "Merge step")).toBeUndefined();
    expect(l.figures.map((f) => f.value)).toEqual(["3", "+108", "−1"]);
  });
  test("on its pull request, where Ship merges, it merges", () => {
    const l = mergeFixLedger({ problem: "ct-57509", plan: plan({ pr: { action: "shepherd", repository: "x/y", number: 9 }, merge: { will: true, method: "squash", why: "", via: "pr" } }), change, approved: null, prNumber: 9 });
    assertGlance(l);
    expect(l).toMatchObject({ name: "Merge this fix", confirm: "Merge" });
    expect(l.alert).toBeUndefined();
    expect(l.rows.find((r) => r.k === "Pull request")?.v).toBe("#9");
  });
  test("nobody answered: the press is the approval, and the review says so", () => {
    const l = mergeFixLedger({ problem: "ct-58282", plan: plan({ branch: "codecast/line-ct-58282" }), change, approved: null, prNumber: null });
    assertGlance(l);
    expect(l.shift).toEqual(["Unanswered", "Pull request"]);
    expect(l.rows.find((r) => r.k === "Approved")).toMatchObject({ v: "By this press", tone: "warn" });
  });
  test("a plan that would gather changes off main has found no fix: blocked, never shipped", () => {
    const l = mergeFixLedger({ problem: "ct-57509", plan: plan({ newBranch: true, branch: "ship/ct-57509" }), change, approved: "sd-583", prNumber: null });
    expect(l.blocked).toBe("No fix branch found");
  });
  test("the button names what the press does", () => {
    expect(fixActName(null)).toBe("Ship this fix");
    expect(fixActName(plan())).toBe("Open its pull request");
    expect(fixActName(plan({ merge: { will: true, method: "squash", why: "", via: "pr" } }))).toBe("Merge this fix");
  });
});
