import { describe, expect, test } from "bun:test";
import { askAgentFields, stepBackWords, cameBackPattern, cameBackTryResult, cameBackTryWords, caseChanged, decisionAnswer, defaultTryPick, labeledCases, outcomeVerb, saveState, triesOf, tryCandidates, TRY_PICKUP_MS, type LineTryRow } from "../lineActions";
import type { LineStep, StepDecision } from "../lineModel";

const row = (over: Partial<LineTryRow>): LineTryRow => ({
  _id: over._id ?? "a", key: "k", try_id: "t1", workflow_id: "w", node_id: "investigate", run_id: over.run_id ?? "r1", by: "u", at: 1000, updated_at: 1000, status: "queued", old: {}, ...over,
});

describe("tries", () => {
  test("a case decided differently when its json moved; the same when it did not; unknown without an old answer", () => {
    expect(caseChanged(row({ status: "done", old: { result: { cause: "a" } }, new: { result: { cause: "b" } } }))).toBe(true);
    expect(caseChanged(row({ status: "done", old: { result: { a: 1, b: 2 } }, new: { result: { b: 2, a: 1 } } }))).toBe(false);
    expect(caseChanged(row({ status: "done", old: {}, new: { result: { cause: "b" } } }))).toBeNull();
    expect(caseChanged(row({ status: "running" }))).toBeNull();
    // Same decision, other words: the same.
    expect(caseChanged(row({ status: "done", old: { result: { outcome: "mechanism", statement: "a lock", evidence: "" } }, new: { result: { outcome: "mechanism", statement: "the lock" } } }))).toBe(false);
  });

  test("a step's tries group their cases, newest first, with a tally", () => {
    const tries = triesOf([
      row({ _id: "1", try_id: "old", at: 10, status: "done", old: { result: { x: 1 } }, new: { result: { x: 1 } }, cost_usd: 0.2 }),
      row({ _id: "2", try_id: "new", at: 20, run_id: "r1", status: "done", old: { result: { x: 1 } }, new: { result: { x: 2 } }, cost_usd: 0.3 }),
      row({ _id: "3", try_id: "new", at: 20, run_id: "r2", status: "not_tryable", reason: "gone" }),
      row({ _id: "4", try_id: "new", at: 20, node_id: "other" }),
    ], "investigate", 30);
    expect(tries.map((t) => t.id)).toEqual(["new", "old"]);
    expect(tries[0]).toMatchObject({ settled: 2, changed: 1, same: 0, done: true, cost: 0.3, stalled: null });
    expect(tries[1]).toMatchObject({ same: 1 });
  });

  test("a try no machine picked up says so", () => {
    expect(triesOf([row({})], "investigate", 1000 + TRY_PICKUP_MS + 1)[0].stalled).toMatch(/has not picked the try up/);
    expect(triesOf([row({ pickup: { error: "expired_ttl" } })], "investigate", 1001)[0].stalled).toMatch(/was not on/);
  });

  test("an answer names what the json decided", () => {
    expect(decisionAnswer({ result: { dissolved: true }, words: "Gone." })).toEqual({ outcome: "dissolved", words: "Gone." });
    expect(decisionAnswer({ result: { verdict: "mechanism", cause: "x" } }).outcome).toBe("mechanism");
    expect(decisionAnswer({ outcome: "success", words: "w" }).outcome).toBeNull();
  });
});

describe("saveState", () => {
  test("the daemon's write, then its push", () => {
    expect(saveState({ executed_at: null })).toEqual({ kind: "saving" });
    expect(saveState({ executed_at: 5, error: "not tracked" })).toEqual({ kind: "refused", reason: "not tracked" });
    expect(saveState({ executed_at: 5, result: JSON.stringify({ changed: true, node_hash: "abc", published: { ok: "pending" } }) })).toEqual({ kind: "pushing", hash: "abc" });
    expect(saveState({ executed_at: 5, result: JSON.stringify({ changed: true, node_hash: "abc", published: { ok: true } }) })).toEqual({ kind: "saved", hash: "abc", at: 5 });
    expect(saveState({ executed_at: 5, result: JSON.stringify({ changed: false }) })).toEqual({ kind: "unchanged" });
  });
});

const decision = (over: Partial<StepDecision>): StepDecision => ({
  id: over.runId ?? "r", runId: over.runId ?? "r", caseId: null, caseRef: "ct-1", caseTitle: "Bookings stall", at: 1, durationMs: 1, status: "done",
  received: { from: null, fromLabel: null, summary: "", sessionId: null, href: null },
  decided: { outcome: "success", words: "Found a stale lock.", result: { cause: "stale-lock" }, to: null, toLabel: null, toWords: null },
  reasoning: null, label: null, labels: [], ...over,
});
const label = (verdict: "right" | "wrong", note: string | null = null) => ({ verdict, note, by: "u", byName: null, at: 1, mine: true });

describe("asking an agent", () => {
  const step = {
    id: "investigate", label: "Investigate",
    prompt: { kind: "prompt", text: "x", readable: "x", includes: [], file: "outreach/line/agentwatch/investigate.md", version: { hash: "abcdef123", since: 1, runs: 3, earlier: false } },
    decisions: [decision({ runId: "r1", label: label("right") }), decision({ runId: "r2", label: label("wrong", "It was a race, not a lock") }), decision({ runId: "r3" })],
  } as unknown as LineStep;

  test("the labeled cases go with the words, wrong first, with where the step lives", () => {
    const f = askAgentFields({ graphTitle: "Agentwatch", step, words: "Stop calling races locks.", cases: labeledCases(step) })!;
    expect(f.subject).toBe("line:station:investigate");
    expect(f.title).toBe("Stop calling races locks.");
    expect(f.detail_md).toContain("`outreach/line/agentwatch/investigate.md`");
    expect(f.detail_md).toContain("version abcdef");
    const wrongAt = f.detail_md.indexOf("**Wrong**");
    expect(wrongAt).toBeGreaterThan(0);
    expect(wrongAt).toBeLessThan(f.detail_md.indexOf("**Right**"));
    expect(f.detail_md).toContain("It was a race, not a lock");
    expect(f.detail_md).toContain("run `r2`");
    expect(f.detail_md).toContain('"cause": "stale-lock"');
  });

  test("nothing to say is no ask", () => {
    expect(askAgentFields({ graphTitle: "g", step, words: "  ", cases: [] })).toBeNull();
  });

  test("try offers the cases marked wrong first, then right, then the newest", () => {
    expect(tryCandidates(step).map((d) => d.runId)).toEqual(["r2", "r1", "r3"]);
  });
});

// Dissolve on AgentWatch: ct-57367 came back 3x and ct-57368 9x after a dissolve; the rest held.
describe("try on the cases the problem came back after", () => {
  const dissolved = { outcome: "dissolved", words: "Already fixed.", result: null, to: null, toLabel: null, toWords: null };
  const back = (count: number, total = count) => ({ kind: "dissolved" as const, held: false, count, total, words: `Came back ${count}x after attempt 1 dissolved it` });
  const step = {
    id: "dissolve", label: "Dissolve",
    decisions: [
      decision({ runId: "a", caseId: "c-58022", decided: dissolved, closed: { kind: "dissolved", held: true, count: 0, total: 0, words: null } }),
      decision({ runId: "b", caseId: "c-57367", decided: { ...dissolved, result: { outcome: "dissolved", kind: "in_flight" } }, closed: back(3) }),
      decision({ runId: "c", caseId: "c-57382" }),
      decision({ runId: "d", caseId: "c-57368", decided: { ...dissolved, result: { outcome: "dissolved", kind: "already_fixed" } }, closed: back(7, 9) }),
      decision({ runId: "e", caseId: "c-57487", label: label("wrong") }),
    ],
  } as unknown as LineStep;

  test("they come first, the most first, and are picked with the labeled ones", () => {
    const candidates = tryCandidates(step);
    expect(candidates.map((d) => d.runId).slice(0, 3)).toEqual(["d", "b", "e"]);
    expect(defaultTryPick(candidates)).toEqual(["d", "b", "e"]);
  });

  test("each says what came back and what it should no longer do; the result says whether it still does", () => {
    expect(cameBackTryWords(step.decisions[1])).toBe("came back 3x after this run, should not dissolve");
    // A later close on a case that came back before it: its own count, and the case's in all.
    expect(cameBackTryWords(step.decisions[3])).toBe("came back 7x after this run, 9x in all, should not dissolve");
    expect(cameBackTryWords(step.decisions[0])).toBeNull();
    expect(cameBackTryResult("dissolved", false)).toBe("still dissolves it");
    expect(cameBackTryResult("dissolved", true)).toBe("no longer dissolves it");
    expect(cameBackTryResult("dissolved", null)).toBeNull();
  });

  test("an ask carries the came-back closes as presumed wrong, after the labeled wrong ones, and names the pattern they share", () => {
    const cases = labeledCases(step);
    expect(cases.map((c) => [c.runId, c.verdict, c.cameBack ?? 0])).toEqual([["e", "wrong", 0], ["b", "wrong", 3], ["d", "wrong", 7]]);
    const f = askAgentFields({ graphTitle: "Agentwatch", step: { ...step, prompt: null } as unknown as LineStep, words: "Stop dissolving these.", cases })!;
    expect(f.detail_md).toContain("**Came back 7x after this run, 9x in all**");
    expect(f.detail_md).toContain("presume those closes wrong");
    // Owned elsewhere in two words ("in flight", "already fixed") is one argument.
    expect(cameBackPattern(step)).toBe("It dissolves causes that came back after an earlier dissolve on the same owned-elsewhere argument.");
    expect(cameBackPattern({ decisions: step.decisions.slice(0, 2) })).toBeNull();
    const other = decision({ runId: "f", caseId: "c-1", decided: { ...dissolved, result: { outcome: "dissolved", kind: "historical" } }, closed: back(1) });
    const known = decision({ runId: "g", caseId: "c-2", decided: { ...dissolved, result: { outcome: "dissolved", kind: "known_cause" } }, closed: back(1) });
    expect(cameBackPattern({ decisions: [...step.decisions, other] })).toBe("It dissolves causes that came back after an earlier dissolve, most on the same owned-elsewhere argument.");
    expect(cameBackPattern({ decisions: [...step.decisions, other, known] })).toBe("It dissolves causes that came back after an earlier dissolve.");
  });

  test("an outcome reads as its verb", () => {
    expect(["dissolved", "dropped", "closed", "shipped", "parked", "carried", "released", "not reproduced"].map(outcomeVerb))
      .toEqual(["dissolve", "drop", "close", "ship", "park", "carry", "release", null]);
  });
});

describe("stepBackWords", () => {
  const tally = { total: 2, rows: [{ key: "failed", n: 2, back: 1, to: null, toLabel: null }], failed: 2, cutOff: 0, live: 0 };
  const out = (toLabel: string, count: number, back: number) => ({ key: `s->${toLabel}`, words: "", to: toLabel, toLabel, count, back, kind: "end" as const, does: null });
  test("counts closes by the end they went to, the word the step's can-end caption says", () => {
    expect(stepBackWords({ tally, outcomes: [out("Owned elsewhere", 2, 1)] } as unknown as LineStep)).toBe("1 of 2 owned-elsewhere came back");
    expect(stepBackWords({ tally, outcomes: [out("Dissolved", 6, 6), out("Investigate", 18, 0)] } as unknown as LineStep)).toBe("all 6 dissolves came back");
  });
  test("falls back to the tally's key when no edge recorded the closes", () => {
    expect(stepBackWords({ tally } as unknown as LineStep)).toBe("1 of 2 fails came back");
  });
});
