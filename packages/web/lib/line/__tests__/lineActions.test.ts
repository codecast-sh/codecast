import { describe, expect, test } from "bun:test";
import { askAgentFields, caseChanged, decisionAnswer, labeledCases, saveState, triesOf, tryCandidates, TRY_PICKUP_MS, type LineTryRow } from "../lineActions";
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
