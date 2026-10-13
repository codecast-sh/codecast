// The problem page reads three things the line itself records: a gate that failed on the machine fault a problem is
// about (ct-58282), an approved Ship its landing step refused for being behind main (ct-58259), and a build handed off
// for review whose run row must not say "Failed" while the band says it waits on a review (ct-57637).
import { expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineIssue, LineStep } from "../lineModel";
import { faultsNaming, stepFaults } from "../lineFaults";
import { bandLine, problemBand, problemNow, workRows, type BandInput } from "../problemPage";
import { behindBase } from "../runReport";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 13, 12);
const hist = (o: Partial<CauseHistory> = {}): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts: [], ships: [], deploys: [], coverage: { state: "known", targets: [], words: "", live: [] } as never,
  watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0, ...o,
});
const attempt = (o: Partial<HistoryAttempt> = {}): HistoryAttempt => ({
  runId: "run1", n: 1, start: NOW - 30 * H, end: NOW - 20 * H, live: false, outcome: { tone: "calm", end: null, text: "" }, ended: null, endStep: null,
  unapproved: false, superseded: false, found: null, argued: null, proposed: null, built: null, card: null, diff: null, merge: null, ...o,
});
const issue = (o: Partial<LineIssue> = {}): LineIssue => ({
  id: "t1", ref: "ct-1", title: "A problem", status: "open", findings: 3, quotes: [], runs: [], lastRunAt: 0, where: { tone: "calm", end: null, text: "" }, history: hist(),
  ask: null, dissolvedWhy: null, dissolvedFixedAt: null, ...o,
});
const input = (o: Partial<BandInput>): BandInput => ({ issue: issue(), history: hist(), run: null, need: null, decision: null, row: null, task: { status: "open", goal_ref: "in-1" }, lineOn: true, now: NOW, ...o });

const evalStep = (decisions: Array<{ runId: string; caseRef: string; at: number; infra: string | null; status?: string }>): Record<string, LineStep> => ({
  eval: { id: "eval", label: "Eval", decisions: decisions.map((d) => ({ id: `${d.runId}:eval`, runId: d.runId, caseId: d.caseRef, caseRef: d.caseRef, caseTitle: "", at: d.at, durationMs: 1, status: d.status ?? "failed", received: {}, decided: { outcome: "failure", words: "", result: d.infra ? { gate: { infra: d.infra } } : null, to: null, toLabel: null, toWords: null }, reasoning: null, label: null, labels: [] })) } as unknown as LineStep,
});

test("a gate that fails on the fault a problem names is that problem happening again; plain words never match", () => {
  const faults = stepFaults(evalStep([
    { runId: "r1", caseRef: "ct-58056", at: NOW - 2 * H, infra: "layer 3 cannot run: L3_DATABASE_URL is not set (layer 3 needs a loopback Postgres); the eval command exited 2" },
    { runId: "r2", caseRef: "ct-9", at: NOW - 3 * H, infra: "layer 2 cannot run: the database is down" },
    { runId: "r3", caseRef: "ct-8", at: NOW - 4 * H, infra: null },
  ]));
  expect(faults.map((f) => f.words)).toEqual(["Layer 3 cannot run: L3_DATABASE_URL is not set", "Layer 2 cannot run: the database is down"]);
  const title = "Every line run's Eval gate fails because the line spawns run-full-suite.sh without L3_DATABASE_URL";
  expect(faultsNaming(title, faults).map((f) => f.caseRef)).toEqual(["ct-58056"]);
  expect(faultsNaming("The database layer is slow", faults)).toEqual([]);
});

test("in production with the line failing on its fault since is not quiet (ct-58282)", () => {
  const live = NOW - 18 * H;
  const h = hist({ ships: [{ runId: "run1", at: live - H, merge: { sha: "abc", branch: "b", into: "main", at: live - H, prUrl: null, repository: null }, deploys: [{ at: live, target: "production", url: null }] } as never], attempts: [attempt({ ended: "shipped" })] });
  const fault = { runId: "rx", caseId: "t9", caseRef: "ct-58056", step: "eval", stepLabel: "Eval", words: "Layer 3 cannot run: L3_DATABASE_URL is not set", at: NOW - 2 * H };
  const before = { ...fault, runId: "ry", at: live - 5 * H };
  const quiet = problemBand(input({ history: h, issue: issue({ history: h, lineFaults: [before] }) }));
  expect(bandLine(quiet).text).toMatch(/, quiet$/);
  const b = problemBand(input({ history: h, issue: issue({ history: h, lineFaults: [fault, before] }) }));
  expect(b.kind === "production" && b.faults.map((f) => f.runId)).toEqual(["rx"]);
  expect(bandLine(b)).toEqual({ text: expect.stringMatching(/the line failed on it 1x since$/), tone: "bad" });
});

test("an answered Ship refused for being behind main is approved and waits to land, never a failure (ct-58259)", () => {
  const out = "line: codecast/line-ct-58259 is behind origin/main; rebase it first, so the squash carries only this change\nthe ship command exited 1 and said nothing";
  expect(behindBase(out)).toBe("main");
  const card = { decisionId: "d", ref: "sd-539", headline: null, change: null, wrong: null, recommend: null, status: "answered", answer: "Ship", note: null, answeredAt: NOW - 90 * H, answeredBy: null };
  const h = hist({ attempts: [attempt({ card, outcome: { tone: "failed", end: null, text: "Failed at Ship" }, diff: { files: 2, added: 88, removed: 4, pr: null } })] });
  const row = { kind: "failed" as const, at: NOW - 90 * H, detail: null, fail: { key: "ship", step: "ship", label: "Ship failed", raw: "" } as never };
  const b = problemBand(input({ history: h, row, shipOutput: out }));
  expect(b.kind === "approved" && b.behind).toBe("main");
  expect(problemNow(b)).toEqual({ status: "approved", phrase: expect.stringMatching(/^Approved \w+ \d+, could not land: behind main$/) });
  // Nobody answered Ship: a refusal is not an approval (ct-59561's runner took the Ship edge on a withdrawn card).
  const withdrawn = problemBand(input({ history: hist({ attempts: [attempt({ card: { ...card, status: "withdrawn", answer: null }, outcome: { tone: "failed", end: null, text: "" } })] }), row, shipOutput: out }));
  expect(withdrawn.kind === "approved" && withdrawn.behind).toBeFalsy();
});

test("a run handed off for review reads so in Work, as the band does (ct-57637)", () => {
  const h = hist({ attempts: [attempt({ outcome: { tone: "failed", end: null, text: "Failed at Verify" } })] });
  expect(workRows(h, [], { review: () => null })[0].outcome).toMatch(/^Failed/);
  const row = workRows(h, [], { review: (id) => (id === "run1" ? "Implement" : null) })[0];
  expect(row.outcome).toBe("Handed off for review at Implement");
  expect(row.tone).toBe("warn");
});
