import { expect, test } from "bun:test";
import { checkRows, trialFacts } from "../../../trial/TrialFactsStrip";
import { UNSCORED_DETAIL } from "@codecast/shared/contracts/changeCard";

const card = {
  cause: { task: "ct-1", title: "t", signals: 1, first_seen: null, sources: [] }, goal: { ref: "g", name: "g", why: "w" }, wrong: "w", change: "c",
  proof: { before: [{ name: "repro", ok: false, detail: " 0 pass\n 20 fail" }], after: [{ name: "repro", ok: true, detail: " 20 pass\n 0 fail" }] },
  examples: [], reach: { conversations: 19, of: 21, covers: ["sg-1"] }, checks: [{ name: "Verify", ok: true, detail: "green" }],
  diff: { files: 4, added: 61, removed: 8 }, risk: { class: "low", reason: "" }, recommend: { verdict: "ship", why: "" }, cost: { tokens: 1, usd: 17.62, minutes: 40 },
};
const row = (extra: object) => ({ task_id: "t1", task_short_id: "ct-1", run_id: "r1", card, evidence: { findings: 21, conversations: 21, withdrawn: 0, moved_to: [] }, ...extra }) as never;

test("each figure a person ships on opens the thing it counts; Live now links to the findings", () => {
  const by = Object.fromEntries(trialFacts(row({ branch: { repository: "a/b", name: "codecast/x", base: "origin/main" } })).map((f) => [f.label, f]));
  expect(by.Repro.opens).toBe("proof");
  expect(by.Checks.opens).toBe("checks");
  expect(by.Reaches.opens).toBe("reach");
  expect(by.Diff.opens).toBe("diff");
  expect(by["Live now"].href).toBe("/line?view=problems&case=ct-1");
});

test("a card with no branch read keeps Diff a plain figure", () => {
  const diff = trialFacts(row({ branch: null })).find((f) => f.label === "Diff")!;
  expect(diff.opens).toBeUndefined();
});

test("the Checks tile counts the rows it opens to: owed evals are the unrun Eval, said in its row (sd-600)", () => {
  const checks = [{ name: "Verify", ok: true, detail: "4/4 pass" }, { name: "Review", ok: true, detail: "approve" }, { name: "Repro", ok: true, detail: "20/20" }, { name: "Eval", ok: false, detail: UNSCORED_DETAIL }];
  const c = row({ card: { ...card, checks }, evals_owed: ["broker-tone", "missed-call"] }) as Parameters<typeof checkRows>[0];
  const rows = checkRows(c);
  const tile = trialFacts(c as never).find((f) => f.label === "Checks")!;
  expect(rows.map((r) => `${r.state} ${r.name}`)).toEqual(["green Verify", "green Review", "green Repro", "idle Eval"]);
  expect(tile.value).toBe("3 green · 1 not run");
  expect(rows.find((r) => r.state === "idle")!.detail).toContain("broker-tone, missed-call");
  expect(trialFacts(c as never).some((f) => f.label === "Evals")).toBe(false);
});

test("with no unrun check the owed evals are a not-run row of their own, and the tile counts it", () => {
  const c = row({ evals_owed: ["broker-tone"] }) as Parameters<typeof checkRows>[0];
  expect(checkRows(c).map((r) => `${r.state} ${r.name}`)).toEqual(["green Verify", "idle Evals owed"]);
  expect(trialFacts(c as never).find((f) => f.label === "Checks")!.value).toBe("1 green · 1 not run");
});
