// problem_page round 18 (journeys log): a stalled Prove read as stopped, a finding that came back from a split, the
// last failed ship over a new Ship ask, and the card's Verify figure taken from its run.
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import type { LineRunModel, LineVisit } from "../lineModel";
import { cameBack, lastShipFailure, stepDone, workRows } from "../problemPage";
import { runVerifyFigure } from "../runVerify";

const NOW = Date.UTC(2026, 9, 13, 16);
const H = 3_600_000;
const hist = (attempts: HistoryAttempt[]): CauseHistory => ({
  occurrences: [], occurrencesFrom: "history", since: null, capped: false, attempts, ships: [], deploys: [], coverage: { state: "unread", targets: [], words: "" },
  watches: [], regressions: [], closes: [], recurrences: [], regressed: false, cameBack: false, firstAt: null, lastActivity: 0,
});
const attempt = (o: Partial<HistoryAttempt>): HistoryAttempt => ({
  runId: "run1", n: 1, start: NOW - 30 * H, end: NOW - 20 * H, live: false, outcome: { tone: "failed", end: null, text: "Stopped" }, ended: null, endStep: null,
  unapproved: false, superseded: false, found: null, argued: null, proposed: null, built: null, card: null, diff: null, merge: null, ...o,
});
const visit = (node: string, status: LineVisit["status"]): LineVisit => ({
  index: 0, node, label: node.charAt(0).toUpperCase() + node.slice(1), kind: "session", at: NOW, startedAt: NOW, completedAt: NOW, durationMs: 60_000, status, inferred: false,
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null }, decided: { outcome: null, words: "", result: null, to: null, toLabel: null, toWords: null }, why: null, sessionId: null,
});
const run = (id: string, visits: LineVisit[], o: Partial<LineRunModel> = {}): LineRunModel => ({
  id, caseId: "t1", caseRef: "ct-57445", caseTitle: "Call cards", status: "failed", live: false, outcome: { tone: "failed", end: null, text: "" }, at: NOW, updatedAt: NOW,
  durationMs: H, at_node: null, graphHash: null, visits, ...o,
});

describe("a run that stalled after its step finished (ct-57445)", () => {
  const h = hist([attempt({ runId: "r2", n: 2 }), attempt({ runId: "r3", n: 3, live: true, end: null, outcome: { tone: "live", end: null, text: "Running" } })]);
  const stalled = (id: string) => (id === "r2" ? { step: "Prove", node: "prove", next: "Build" } : null);
  test("reads done and stalled, never 'Stopped at Prove', and names the run that replaced it", () => {
    const runs = [run("r2", [visit("analyze", "done"), visit("prove", "failed")]), run("r3", [visit("analyze", "done"), visit("prove", "live")], { live: true, status: "running" })];
    const rows = workRows(h, runs, { stalled });
    const r2 = rows.find((r) => r.n === 2)!;
    expect(r2.outcome).toBe("Proved, stalled before Build · replaced by Run 3 (Prove redone)");
    expect(r2.replaced).toEqual({ by: "r3", step: "Prove", redone: true });
  });
  test("a later run that started past the step kept it", () => {
    const runs = [run("r2", [visit("prove", "failed")]), run("r3", [visit("implement", "live")], { live: true, status: "running" })];
    expect(workRows(h, runs, { stalled }).find((r) => r.n === 2)!.outcome).toBe("Proved, stalled before Build · replaced by Run 3 (Prove kept)");
  });
  test("a step with no done word says it finished", () => {
    expect(stepDone("Red")).toBe("Red finished");
  });
});

describe("cameBack (ct-59338's sg-2635)", () => {
  const signals = [{ _id: "s1", title: "The message opens by narrating Union's own effort (a voicemail and a promised follow-up)." }, { _id: "s2", title: "Another finding about missed calls and openers." }];
  test("a finding a run split to its own problem, merged back, names that problem", () => {
    expect(cameBack(signals, [{ ref: "ct-59666", title: "The message opens by narrating Union's own effort (a voicemail and a promised follow-up)." }])).toEqual(new Map([["s1", "ct-59666"]]));
  });
  test("a problem merged in that only quotes the finding in its description was its own problem (ct-59533)", () => {
    expect(cameBack(signals, [{ ref: "ct-59533", title: "Emails we promised by phone open on that promise" }]).size).toBe(0);
  });
});

describe("lastShipFailure (ct-59561)", () => {
  const ship = (status: string, said: string) => ({ node_id: "ship", status, completed_at: NOW - 17 * H, result_preview: said });
  const refused = "line: codecast/line-ct-59561 is behind origin/main; rebase it first, so the squash carries only this change\nthe ship command exited 1 and said nothing\nok Comment added to ct-59561";
  test("the newest run asks again: the earlier refusal, in its own first words, with its run's number", () => {
    const runs = [
      { _id: "r4", created_at: 4, node_statuses: [{ node_id: "review", status: "completed" }] },
      { _id: "r5", created_at: 5, node_statuses: [{ node_id: "decide", status: "failed" }, ship("failed", refused)] },
      { _id: "r6", created_at: 6, node_statuses: [{ node_id: "decide", status: "running" }] },
    ];
    expect(lastShipFailure(runs)).toEqual({ runId: "r5", n: 2, at: NOW - 17 * H, said: "codecast/line-ct-59561 is behind origin/main; rebase it first, so the squash carries only this change", behind: true });
  });
  test("nothing when the last landing worked, or the newest run is landing itself", () => {
    expect(lastShipFailure([{ _id: "r5", created_at: 5, node_statuses: [ship("completed", "Shipped")] }, { _id: "r6", created_at: 6, node_statuses: [] }])).toBeNull();
    expect(lastShipFailure([{ _id: "r5", created_at: 5, node_statuses: [ship("failed", refused)] }, { _id: "r6", created_at: 6, node_statuses: [ship("running", "")] }])).toBeNull();
  });
});

describe("runVerifyFigure (ct-59338: Verify 4/4 on the run, the card's tile counted its own four checks)", () => {
  test("the run's verify report in one glance", () => {
    const report = JSON.stringify({ ok: true, steps: [{ name: "typecheck", ok: true }, { name: "tripwires", ok: true }, { name: "touched tests (1)", ok: true }, { name: "prompt fidelity (x)", ok: true }] });
    expect(runVerifyFigure([{ node_id: "verify", result_preview: `${report}\ncheck: typecheck` }])).toEqual({ text: "4/4 pass", bad: false, pass: 4, of: 4 });
    expect(runVerifyFigure([{ node_id: "implement", result_preview: "done" }])).toBeNull();
  });
});
