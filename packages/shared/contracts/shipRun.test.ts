import { describe, expect, test } from "bun:test";
import { selectSessionRun, shipOfLiveRun, shipStageOfNode } from "./shipRun";

describe("selectSessionRun", () => {
  const r = (id: string, status: string, created_at: number, over: Record<string, unknown> = {}) => ({ id, status, created_at, ...over });
  test("the live ship run first, newest first; else the newest live other run; never an ended one", () => {
    expect(selectSessionRun([r("eval", "running", 2), r("change", "running", 1, { workflow_name: "change" })])?.id).toBe("change");
    expect(selectSessionRun([r("a", "running", 1, { takes_change: true }), r("b", "paused", 2, { takes_change: true })])?.id).toBe("b");
    expect(selectSessionRun([r("old", "running", 1), r("new", "pending", 2)])?.id).toBe("new");
    expect(selectSessionRun([r("stopped", "failed", 3, { workflow_name: "change" }), r("live", "running", 1)])?.id).toBe("live");
    expect(selectSessionRun([r("done", "completed", 1)])).toBeNull();
  });
});

describe("shipStageOfNode", () => {
  test("every change, personal and deploy station maps to a stage", () => {
    const stage = (id: string, label?: string) => shipStageOfNode(id, label);
    for (const id of ["pr", "local_ci", "local_ci_fix", "checks", "ci", "retest", "wait_main", "onto_main", "ci_conflict", "round", "check"]) expect([id, stage(id)]).toEqual([id, "ci"]);
    for (const id of ["review", "verdicts", "decide", "brief", "joined", "direct_review", "direct_fix"]) expect([id, stage(id)]).toEqual([id, "review"]);
    for (const id of ["merge", "landed", "land", "rebase", "ship", "fix_conflict", "after_fix"]) expect([id, stage(id)]).toEqual([id, "merge"]);
    for (const id of ["deploy", "direct_deploy", "deploy_fix", "left"]) expect([id, stage(id)]).toEqual([id, "deploy"]);
    expect(stage("deploy__wait")).toBe("live");
    expect(stage("anything", "Go live")).toBe("live");
  });
});

describe("shipOfLiveRun", () => {
  test("a held step says the hold, with who holds it; a step underway says its stage", () => {
    const gate = { status: "paused", current_node_id: "decide", gate_decision_id: "d1", gate_decision_status: "pending" };
    expect(shipOfLiveRun(gate, { gateIsViewers: true })).toEqual({ stage: "review", holder: "you", words: "Your call" });
    expect(shipOfLiveRun(gate)).toEqual({ stage: "review", holder: "other", words: "Waiting for approval" });
    const deploy = (line: string) => ({ status: "running", current_node_id: "deploy__wait", node_statuses: [{ node_id: "deploy__wait", result_preview: line, started_at: 1 }] });
    expect(shipOfLiveRun(deploy("waiting on main CI at abc (red, 3 failing)"))).toEqual({ stage: "live", holder: "other", words: "Waiting for green main" });
    expect(shipOfLiveRun(deploy(""))).toEqual({ stage: "live" });
    expect(shipOfLiveRun({ status: "running", current_node_id: "ci", waiting_on_session: { blocked: false }, pr: { number: 9 } })).toEqual({ stage: "ci", pr: "#9", failed: true });
    expect(shipOfLiveRun({ status: "running", current_node_id: "ci", waiting_on_session: { blocked: true } }, { askIsViewers: true })).toEqual({ stage: "ci", holder: "you", words: "Waiting on you" });
  });
});
