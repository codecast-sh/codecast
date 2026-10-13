import { describe, expect, test } from "bun:test";
import { currentOnly, gateOutdated, problemFactsOf, supersededCard, supersededFinding, supersededProblem, supersededRun } from "./superseded";

describe("supersededProblem", () => {
  test("a merged problem names its survivor", () => {
    expect(supersededProblem({ status: "dropped", merged_into: "ct-2", live_findings: 0, gone_findings: 3 })).toEqual({ why: "merged", by: "ct-2" });
  });
  test("an open problem whose findings all left is superseded", () => {
    expect(supersededProblem({ status: "in_review", live_findings: 0, gone_findings: 4 })).toEqual({ why: "emptied" });
  });
  test("a problem that never held a finding is current", () => {
    expect(supersededProblem({ status: "open", live_findings: 0, gone_findings: 0 })).toBeNull();
  });
  test("a problem with a live finding is current", () => {
    expect(supersededProblem({ status: "open", live_findings: 1, gone_findings: 9 })).toBeNull();
  });
  test("facts from the task row: a cause filed by hand has no cause, a cause born empty has no last_seen", () => {
    expect(supersededProblem(problemFactsOf({ status: "open" }))).toBeNull();
    expect(supersededProblem(problemFactsOf({ status: "open", cause: { signal_count: 0, last_seen: 0 } }))).toBeNull();
    expect(supersededProblem(problemFactsOf({ status: "in_review", cause: { signal_count: 0, last_seen: 5 } }))).toEqual({ why: "emptied" });
    expect(supersededProblem(problemFactsOf({ status: "in_review", cause: { signal_count: 2, last_seen: 5 } }))).toBeNull();
  });
  test("a closed empty problem is history, not superseded", () => {
    expect(supersededProblem({ status: "done", live_findings: 0, gone_findings: 2 })).toBeNull();
  });
});

describe("supersededRun", () => {
  const live = { status: "paused", station_gone: false } as const;
  test("a live run is current", () => {
    expect(supersededRun(live)).toBeNull();
  });
  test("a newer run on the same problem replaces a live one", () => {
    expect(supersededRun({ ...live, newer_run: "r2" })).toEqual({ why: "newer_run", by: "r2" });
  });
  test("a finished run is never superseded, whatever came after", () => {
    expect(supersededRun({ status: "completed", newer_run: "r2", station_gone: true })).toBeNull();
    expect(supersededRun({ status: "failed", newer_run: "r2", station_gone: false })).toBeNull();
  });
  test("a run waiting at a removed station", () => {
    expect(supersededRun({ ...live, station_gone: true })).toEqual({ why: "station_gone" });
  });
  test("a run waiting on a closed problem", () => {
    expect(supersededRun({ ...live, problem_status: "done" })).toEqual({ why: "problem_closed" });
  });
  test("a run on a merged problem names the survivor", () => {
    expect(supersededRun({ ...live, problem: { why: "merged", by: "ct-9" } })).toEqual({ why: "merged", by: "ct-9" });
  });
});

describe("supersededCard", () => {
  const waiting = { waiting: true, run_at_gate: true, live_findings: 5 };
  test("a waiting card on a current run is current", () => {
    expect(supersededCard(waiting)).toBeNull();
  });
  test("an answered card is history", () => {
    expect(supersededCard({ ...waiting, waiting: false, run: { why: "newer_run" } })).toBeNull();
  });
  test("its run's replacement replaces it", () => {
    expect(supersededCard({ ...waiting, run: { why: "station_gone" } })).toEqual({ why: "station_gone" });
  });
  test("a run that left the gate", () => {
    expect(supersededCard({ ...waiting, run_at_gate: false })).toEqual({ why: "run_moved_on" });
  });
  test("a card covering none of the live findings", () => {
    expect(supersededCard({ ...waiting, covered: 0 })).toEqual({ why: "evidence_moved" });
  });
  test("a card that still covers some is current", () => {
    expect(supersededCard({ ...waiting, covered: 2 })).toBeNull();
  });
  test("a card that declares no coverage is never hidden by coverage", () => {
    expect(supersededCard({ ...waiting, covered: null })).toBeNull();
    expect(supersededCard({ ...waiting })).toBeNull();
  });
  test("an emptied problem's card", () => {
    expect(supersededCard({ ...waiting, live_findings: 0, covered: 0, problem: { why: "emptied" } })).toEqual({ why: "emptied" });
  });
});

describe("supersededFinding", () => {
  test("a standing finding is current, even from an older judge version", () => {
    expect(supersededFinding({})).toBeNull();
  });
  test("withdrawn, merged, a case, or ruled", () => {
    expect(supersededFinding({ retired: { at: 1 } })).toEqual({ why: "withdrawn" });
    expect(supersededFinding({ merged_into: "sg-4" })).toEqual({ why: "merged", by: "sg-4" });
    expect(supersededFinding({ case_of: "sg-1" })).toEqual({ why: "withdrawn" });
    expect(supersededFinding({ judge_review: { by: "x" } })).toEqual({ why: "withdrawn" });
  });
  test("a removed judge", () => {
    expect(supersededFinding({ judge_removed: true })).toEqual({ why: "judge_unpublished" });
  });
});

test("currentOnly keeps current rows unless asked for all", () => {
  const rows = [{ id: 1, superseded: null }, { id: 2, superseded: { why: "newer_run" as const } }, { id: 3 }];
  expect(currentOnly(rows).map((r) => r.id)).toEqual([1, 3]);
  expect(currentOnly(rows, true).map((r) => r.id)).toEqual([1, 2, 3]);
});

describe("gateOutdated (a line iteration)", () => {
  const ran = [{ id: "build", h: "b1" }, { id: "card_write", h: "p1" }, { id: "decide", h: "d1" }];
  const current = (nodes: Array<{ id: string; h: string }>, gates: Record<string, { asker?: string }> = { decide: { asker: "card_write" } }) => ({ nodes, gates });
  test("the presenter's prompt changed: its open decision is outdated", () => {
    expect(gateOutdated({ gate: "decide", ran, current: current([{ id: "build", h: "b1" }, { id: "card_write", h: "p2" }, { id: "decide", h: "d1" }]) })).toBe(true);
  });
  test("an unrelated station changed: the decision stays current", () => {
    expect(gateOutdated({ gate: "decide", ran, current: current([{ id: "build", h: "b2" }, { id: "card_write", h: "p1" }, { id: "decide", h: "d1" }]) })).toBe(false);
  });
  test("the gate was removed, or is no longer a person's gate", () => {
    expect(gateOutdated({ gate: "plan_gate", ran, current: current(ran) })).toBe(true);
  });
  test("the gate's own wording changed: the decision stays current", () => {
    expect(gateOutdated({ gate: "decide", ran, current: current([{ id: "build", h: "b1" }, { id: "card_write", h: "p1" }, { id: "decide", h: "d2" }]) })).toBe(false);
  });
  test("a decision made on the current version is current", () => {
    expect(gateOutdated({ gate: "decide", ran, current: current(ran) })).toBe(false);
  });
  test("asked with no presenting session where the line now has one", () => {
    const old = [{ id: "decide", h: "d1" }];
    expect(gateOutdated({ gate: "decide", ran: old, current: current([{ id: "decide", h: "d1" }, { id: "present", h: "x" }], { decide: { asker: "present" } }) })).toBe(true);
  });
  test("unknown facts hide nothing", () => {
    expect(gateOutdated({ gate: "decide", ran: null, current: current([{ id: "decide", h: "d9" }]) })).toBe(false);
    expect(gateOutdated({ gate: "decide", ran, current: null })).toBe(false);
  });
  test("a live run at an outdated gate is superseded by the version; a finished run never is", () => {
    expect(supersededRun({ status: "paused", station_gone: false, line_changed: "v12" })).toEqual({ why: "line_changed", by: "v12" });
    expect(supersededRun({ status: "completed", station_gone: false, line_changed: "v12" })).toBeNull();
    expect(supersededCard({ waiting: true, run_at_gate: true, live_findings: 2, run: { why: "line_changed", by: "v12" } })).toEqual({ why: "line_changed", by: "v12" });
  });
});
