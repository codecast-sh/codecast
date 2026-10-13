// The review of landing an approved fix (MergeFixAct): facts at a glance, and a
// confirm that names what will really happen (ct-57509: merge step off, Ship off).
import { describe, expect, test } from "bun:test";
import type { ShipPlan } from "@codecast/shared/contracts/shipPlan";
import { assertGlance } from "../../../components/consequential/__tests__/glance";
import { mergeFixLedger, shipOnLedger } from "../mergeFixLedger";

const plan = (o: Partial<ShipPlan> = {}): ShipPlan => ({
  procedure: "cast_ship", target: { kind: "task", id: "t1" }, label: "ct-57509", decisionId: null, branch: "codecast/line-ct-57509", newBranch: false, base: "main",
  checks: ["cast ws check"], command: null, pr: { action: "open" }, merge: { will: false, method: "squash", why: "", via: null }, steps: [], blocked: null, ...o,
});
const change = { files: 3, added: 108, removed: 1, pr: null };

describe("mergeFixLedger", () => {
  test("with the merge step off it opens a pull request and says the merge step is off", () => {
    const l = mergeFixLedger({ problem: "ct-57509 · The call gate blocks David Wang", plan: plan(), change, approved: "sd-583 · Oct 12", prNumber: null, mergeStep: false });
    assertGlance(l);
    expect(l).toMatchObject({ name: "Open its pull request", confirm: "Open pull request", alert: "Merge step off", blocked: undefined });
    expect(l.rows.find((r) => r.k === "Merges")?.v).toBe("No");
    expect(l.figures.map((f) => f.value)).toEqual(["3", "+108", "−1"]);
  });
  test("on its pull request, where Ship merges, it merges", () => {
    const l = mergeFixLedger({ problem: "ct-57509", plan: plan({ pr: { action: "shepherd", repository: "x/y", number: 9 }, merge: { will: true, method: "squash", why: "", via: "pr" } }), change, approved: null, prNumber: 9, mergeStep: false });
    assertGlance(l);
    expect(l).toMatchObject({ name: "Merge this fix", confirm: "Merge", alert: undefined });
    expect(l.rows.find((r) => r.k === "Pull request")?.v).toBe("#9");
  });
  test("Ship off: still the review of this fix, with Ship for the whole team as the step it needs first", () => {
    const merge = mergeFixLedger({ problem: "ct-57509", plan: plan(), change, approved: "sd-583 · Oct 12", prNumber: null, mergeStep: false });
    const l = shipOnLedger({ team: "Union", admin: true, merge });
    assertGlance(l);
    expect(l).toMatchObject({ name: merge.name, subject: "ct-57509", confirm: "Turn on Ship", alert: "Ship is off for Union", blocked: undefined });
    expect(l.rows[0]).toMatchObject({ k: "Needs first", v: "Ship on, for all of Union" });
    expect(l.rows.find((r) => r.k === "Approved")?.v).toBe("sd-583 · Oct 12");
  });
  test("Ship off and the viewer is not the team's admin: blocked, and says who can", () => {
    const merge = mergeFixLedger({ problem: "ct-57509", plan: plan(), change, approved: null, prNumber: null, mergeStep: true });
    const l = shipOnLedger({ team: "Union", admin: false, merge });
    assertGlance(l);
    expect(l.blocked).toBe("Only Union admins can turn on Ship");
  });
});
