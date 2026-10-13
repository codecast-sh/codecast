import { expect, test } from "bun:test";
import { trialFacts } from "../../../trial/TrialFactsStrip";

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
