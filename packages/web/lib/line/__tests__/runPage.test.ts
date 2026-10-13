// The run page's pure layer (lib/line/runPage.ts) on runs shaped like the real
// ones on Codecast's line (2026-10-12): which step the page opens on and what
// its one line of state says, for each way a run ends.
import { describe, expect, test } from "bun:test";
import { buildLineModel, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import type { ReportRun } from "../runReport";
import { runNumber, runStop, spanShort, stepMark } from "../runPage";
import { DAY, HOUR, MIN, NOW, n } from "./lineFixtures";

const T0 = NOW - 2 * DAY;
const task = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", created_at: T0 - HOUR, project_id: "proj", cause: { signal_count: 1, first_seen: T0, last_seen: T0, fingerprints: [`x:${id}`] }, ...extra });
const run = (id: string, taskId: string, extra: Partial<MapRun>): MapRun => ({ _id: id, status: "completed", task_id: taskId, workflow_name: "line", created_at: T0, updated_at: T0 + HOUR, ...extra } as MapRun);
const failed = (node: string, at: number, secs: number, outcome?: string) => n(node, at, secs / 60, "failed", outcome ? { outcome } : {});

// Ground fails in 7s, Analyze and Prove fail on nothing, and the engine names Prove (real: ct-58680).
const groundFailed = run("r_ground", "t1", {
  status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome failure, review_verdict none)",
  node_statuses: [n("start", T0, 0), failed("ground", T0 + MIN, 7, "failure"), failed("analyze", T0 + 2 * MIN, 8, "failure"), failed("prove", T0 + 3 * MIN, 26)],
});
// Prove finished its work and the line had no next step for it (real: ct-58737).
const proveDeadEnd = run("r_dead", "t2", {
  status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)",
  node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 2, "completed", { session_id: "s1" }), n("analyze", T0 + 4 * MIN, 3, "completed", { session_id: "s2" }), n("prove", T0 + 8 * MIN, 6, "failed", { session_id: "s3", session: { _id: "s3", state: "Proved it. This fix still needs Cameron's yes before it ships." } } as never)],
});
// Implement went round three times, each sent back by a failing Eval (real: ct-59566).
const looped = run("r_loop", "t3", {
  status: "failed", current_node_id: "implement", fail_reason: "max_visits=3 exceeded on implement",
  node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 2), n("analyze", T0 + 4 * MIN, 3), n("prove", T0 + 8 * MIN, 6), n("red", T0 + 15 * MIN, 1), n("implement", T0 + 17 * MIN, 20, "failed", { session_id: "s4" }), n("verify", T0 + 40 * MIN, 2), n("green", T0 + 43 * MIN, 1), failed("eval", T0 + 45 * MIN, 968, "failure")],
});
// Paused at Decide on sd-615 (real: ct-59561).
const waiting = run("r_wait", "t4", {
  status: "paused", current_node_id: "decide", gate_node_id: "decide", gate_decision_short_id: "sd-615",
  node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 2), n("analyze", T0 + 4 * MIN, 3), n("prove", T0 + 8 * MIN, 6), n("red", T0 + 15 * MIN, 1), n("implement", T0 + 17 * MIN, 20), n("verify", T0 + 40 * MIN, 2), n("eval", T0 + 45 * MIN, 1), n("review", T0 + 47 * MIN, 6), n("card_draft", T0 + 54 * MIN, 1), n("card_write", T0 + 56 * MIN, 1), n("card", T0 + 58 * MIN, 1), n("decide", T0 + HOUR, 0, "running")],
} as Partial<MapRun>);
// Parked by Ground on a fact only a person has (real: ct-59687).
const parked = run("r_park", "t5", { current_node_id: "exit", node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 1, "completed", { session_id: "s5" }), n("park", T0 + 3 * MIN, 0), n("exit", T0 + 4 * MIN, 0)] });
// Building now.
const live = run("r_live", "t6", { status: "running", current_node_id: "implement", updated_at: NOW - MIN, node_statuses: [n("start", T0, 0), n("ground", T0 + MIN, 2), n("analyze", T0 + 4 * MIN, 3), n("prove", T0 + 8 * MIN, 6), n("red", T0 + 15 * MIN, 1), n("implement", NOW - 42 * MIN, 0, "running")] });

const rows: LineModelRows = { runs: [groundFailed, proveDeadEnd, looped, waiting, parked, live], tasks: ["t1", "t2", "t3", "t4", "t5", "t6"].map((t) => task(t)) as unknown as LineModelRows["tasks"], now: NOW };
const m = buildLineModel(rows, "line");
const of = (id: string) => m.runs.find((r) => r.id === id)!;
const raw = (r: MapRun) => r as unknown as ReportRun;
const nodeAt = (id: string, i: number) => of(id).visits[i]?.node;

describe("the true stop", () => {
  test("a run the engine blames on Prove failed first at Ground: the page opens there and says so", () => {
    const r = of("r_ground");
    const stop = runStop(m, r, raw(groundFailed));
    expect(stop.ending).toBe("failed");
    expect(nodeAt("r_ground", stop.at)).toBe("ground");
    expect(stop.line).toBe(`Failed at ${m.steps.ground.label} after 7s`);
    expect(stop.line).not.toContain("Prove");
    expect(stop.cause?.raw).toContain("no outgoing edge");
  });

  test("a loop opens on the check that kept sending the step back, and names the step once", () => {
    const stop = runStop(m, of("r_loop"), raw(looped));
    expect(stop.ending).toBe("failed");
    expect(nodeAt("r_loop", stop.at)).toBe("eval");
    expect(stop.line).toBe(`Failed at ${m.steps.eval.label} 3 times`);
  });

  test("a step that finished with no next step stopped, never failed: the run the viewer is asked about needs a yes", () => {
    const old = runStop(m, of("r_dead"), raw(proveDeadEnd));
    expect(old.ending).toBe("stopped");
    expect(old.line).toBe(`Stopped at ${m.steps.prove.label} after it finished`);
    const stop = runStop(m, of("r_dead"), raw(proveDeadEnd), { asksYes: "Prove finished: go on to Build?" });
    expect(stop.ending).toBe("stopped");
    expect(nodeAt("r_dead", stop.at)).toBe("prove");
    expect(stop.line).toBe("Prove finished: go on to Build?");
    expect(stop.tone).toBe("person");
  });

  test("a step that finished and said nothing has no yes to give: it ended without a report, and starting again is the act", () => {
    const silent = { ...proveDeadEnd, node_statuses: proveDeadEnd.node_statuses!.map((x) => (x.node_id === "prove" ? { ...x, session: { _id: "s3" } } : x)) } as typeof proveDeadEnd;
    const stop = runStop(m, of("r_dead"), raw(silent));
    expect(stop.ending).toBe("failed");
    expect(stop.line).toBe(`${m.steps.prove.label} ended without a report`);
    expect(stop.cause?.key.startsWith("deadend-silent")).toBe(true);
  });

  test("a step a spend limit stopped reads as that, the words Problems and the band use, never 'Failed at Prove' (ct-57836)", () => {
    const capped = { ...proveDeadEnd, node_statuses: proveDeadEnd.node_statuses!.map((x) => (x.node_id === "prove" ? { ...x, session: { _id: "s3", message_count: 37, state_status: "dormant", state: "Proving it\nStatus: prove rerun blocked by the desk eval wallet ($50.36 of $50/day), every rep refused" } } : x)) } as typeof proveDeadEnd;
    const mc = buildLineModel({ ...rows, runs: [capped] }, "line");
    const stop = runStop(mc, mc.runs[0], raw(capped));
    expect(stop.cause?.key).toBe("budget:prove");
    expect(mc.runs[0].visits[stop.at]?.node).toBe("prove");
    expect(stop.line).toBe(`Stopped by a spend limit at ${mc.steps.prove.label}`);
  });
});

describe("the step a run opens on", () => {
  test("waiting on a person: the person step, and the line names who holds it", () => {
    const r = of("r_wait");
    expect(runStop(m, r, raw(waiting)).ending).toBe("waiting");
    expect(nodeAt("r_wait", runStop(m, r, raw(waiting)).at)).toBe("decide");
    expect(runStop(m, r, raw(waiting), { holder: "you" }).line).toStartWith("Waiting on you since ");
    expect(runStop(m, r, raw(waiting), { holder: "other" }).line).toStartWith("Waiting on someone else since ");
    expect(runStop(m, r, raw(waiting)).line).toStartWith("Waiting for an answer since ");
  });

  test("parked: the Park step, said as what it needs", () => {
    const stop = runStop(m, of("r_park"), raw(parked));
    expect(stop.ending).toBe("parked");
    expect(nodeAt("r_park", stop.at)).toBe("park");
    expect(stop.line).toStartWith("Parked ");
    expect(stop.tone).toBe("none");
    expect(runStop(m, of("r_park"), raw(parked), { asksFact: true }).line).toBe("Needs a fact from you");
    expect(runStop(m, of("r_park"), raw(parked), { waitsForFindings: true }).line).toBe("Waiting for more findings");
  });

  test("running: the step it is in, as a verb with how long", () => {
    const stop = runStop(m, of("r_live"), raw(live), { now: NOW });
    expect(stop.ending).toBe("running");
    expect(nodeAt("r_live", stop.at)).toBe("implement");
    expect(stop.line).toBe("Building, 42m");
  });
});

describe("small readings", () => {
  test("a duration in its largest units", () => {
    expect(spanShort(2_000)).toBe("2s");
    expect(spanShort(7 * MIN)).toBe("7m");
    expect(spanShort(2 * HOUR + 5 * MIN)).toBe("2h 5m");
    expect(spanShort(null)).toBeNull();
  });

  test("a run's number among its problem's runs, oldest first, with its neighbours", () => {
    const runs = [{ id: "c", at: 3, caseId: "p" }, { id: "a", at: 1, caseId: "p" }, { id: "b", at: 2, caseId: "p" }, { id: "z", at: 9, caseId: "q" }];
    expect(runNumber(runs, { id: "b", caseId: "p" })).toEqual({ n: 2, of: 3, prev: "a", next: "c" });
    expect(runNumber(runs, { id: "z", caseId: "q" })).toEqual({ n: 1, of: 1, prev: null, next: null });
  });

  test("a trace row's mark: failed by status or by outcome, a waiting person, a skipped earlier round", () => {
    const v = (o: Record<string, unknown>) => ({ status: "done", inferred: false, kind: "agent", decided: { outcome: null }, ...o }) as never;
    expect(stepMark(v({}))).toBe("done");
    expect(stepMark(v({ status: "failed" }))).toBe("failed");
    expect(stepMark(v({ decided: { outcome: "failure" } }))).toBe("failed");
    expect(stepMark(v({ status: "live", kind: "person" }))).toBe("waiting");
    expect(stepMark(v({ status: "live" }))).toBe("live");
    expect(stepMark(v({ inferred: true }))).toBe("skipped");
    expect(stepMark(v({ status: "failed" }), { unanswered: true, notRun: null })).toBe("skipped");
    expect(stepMark(v({ status: "failed" }), { unanswered: false, notRun: "the decision was withdrawn" })).toBe("skipped");
  });
});
