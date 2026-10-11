// A step's decisions counted once (lineModel tallyDecisions), grouped by case
// (decisionsByCase), and tried once per case (lineActions oncePerCase): the
// drawer, the Notebook, the Decisions filters and the chat's widgets read these,
// so a step's counts and its cases agree everywhere.
import { describe, expect, test } from "bun:test";
import { decisionKey, decisionSaid, decisionsByCase, tallyDecisions, type StepDecision } from "../lineModel";
import { oncePerCase } from "../lineActions";

const d = (id: string, over: { status?: StepDecision["status"]; outcome?: string | null; to?: string | null; caseId?: string | null; reasoning?: string | null; words?: string }): StepDecision => ({
  id, runId: id, caseId: over.caseId === undefined ? `c-${id}` : over.caseId, caseRef: null, caseTitle: "", at: null, durationMs: null, status: over.status ?? "done",
  received: { from: null, fromLabel: null, summary: "", sessionId: null, href: null },
  decided: { outcome: over.outcome ?? null, words: over.words ?? "Found why it happens", result: null, to: over.to ?? null, toLabel: over.to ?? null, toWords: null },
  reasoning: over.reasoning ?? null, label: null, labels: [],
});

describe("a step's tally", () => {
  test("a step that decided it failed is apart from a session cut off before deciding", () => {
    expect(decisionKey(d("a", { outcome: "failed" }))).toBe("failed");
    expect(decisionKey(d("a", { status: "failed", outcome: "failed" }))).toBe("failed");
    expect(decisionKey(d("a", { status: "failed" }))).toBe("cut off");
    expect(decisionKey(d("a", { status: "live" }))).toBe("running");
    expect(decisionKey(d("a", { outcome: "mechanism" }))).toBe("mechanism");
    expect(decisionKey(d("a", {}))).toBe("handed on");
    // No outcome reported: the branch the run took is what the step decided; a cut-off session still decided nothing.
    const took = (over: Parameters<typeof d>[1], toWords: string) => { const x = d("a", over); x.decided.toWords = toWords; return x; };
    expect(decisionKey(took({}, "open"))).toBe("open");
    expect(decisionKey(took({ status: "failed" }, "mechanism"))).toBe("cut off");
    // It reported, then its session failed: it still decided what it reported.
    expect(decisionKey(d("a", { status: "failed", outcome: "open" }))).toBe("open");
  });

  test("counts each decision once, the most first, with where most of them went", () => {
    const t = tallyDecisions([
      d("1", { outcome: "open", to: "investigate" }), d("2", { outcome: "open", to: "investigate" }), d("3", { outcome: "dissolved", to: "dissolved_at_dissolve" }),
      d("4", { outcome: "failed" }), d("5", { status: "failed" }), d("6", { status: "failed" }),
    ]);
    expect(t.rows.map((r) => [r.key, r.n])).toEqual([["open", 2], ["cut off", 2], ["dissolved", 1], ["failed", 1]]);
    expect(t.rows[0].to).toBe("investigate");
    expect([t.total, t.failed, t.cutOff]).toEqual([6, 1, 2]);
  });
});

describe("cases", () => {
  const list = [d("r5", { caseId: "A" }), d("r4", { caseId: "B" }), d("r3", { caseId: "A" }), d("r2", { caseId: null }), d("r1", { caseId: "A" })];
  test("a case run several times reads as one case, its newest first, with its earlier runs under it", () => {
    expect(decisionsByCase(list).map((c) => [c.latest.id, c.earlier.map((e) => e.id)])).toEqual([["r5", ["r3", "r1"]], ["r4", []], ["r2", []]]);
  });
  test("Try takes each case once, the first of it in the order given", () => {
    expect(oncePerCase(list).map((x) => x.id)).toEqual(["r5", "r4", "r2"]);
  });
  test("a decision shows what the run found, not the outcome's generic words", () => {
    expect(decisionSaid(d("a", { reasoning: "## Mechanism\nThe prompt lets the agent quote a fee the policy never states.\nMore." }))).toBe("The prompt lets the agent quote a fee the policy never states.");
    expect(decisionSaid(d("a", { words: "Found why it happens" }))).toBe("Found why it happens");
    // A record's id after its noun is dropped; a commit keeps its hash.
    expect(decisionSaid(d("a", { reasoning: "Fee-answer cluster c2cb5312: 5 findings moved to proven causes." }))).toBe("Fee-answer cluster: 5 findings moved to proven causes.");
    expect(decisionSaid(d("a", { reasoning: "Already fixed by commit 9f1c2ab3 on main." }))).toBe("Already fixed by commit 9f1c2ab3 on main.");
  });
});
