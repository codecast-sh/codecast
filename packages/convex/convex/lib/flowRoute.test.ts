import { describe, expect, test } from "bun:test";
import { extendsFlow, flowRouteFor, NO_JUDGE_FLOW, type FlowRouteRow } from "./flowRoute";

const spine: FlowRouteRow = { _id: "w_spine", slug: "agentwatch", source: 'digraph a { graph [kind="line"] }', serves: ["person", "judge:agent-review"], origin: { file: "outreach/line/agentwatch.cast" }, updated_at: 1 };
const system: FlowRouteRow = { _id: "w_system", slug: "agentwatch-system", source: 'digraph s { graph [extends="agentwatch.cast"] }', serves: ["union.eval", "sdk:union-errors"], origin: { file: "outreach/line/agentwatch-system.cast" }, updated_at: 2 };
const judge: FlowRouteRow = { _id: "w_judge", slug: "agentwatch-trial-judge", source: 'digraph j { graph [kind="line", serves="judge-review"] }', serves: ["judge-review"], origin: { file: "outreach/line/agentwatch-trial-judge.cast" }, runs_from: "library", updated_at: 3 };
// Serves a source, but extends no member: outside the family.
const stranger: FlowRouteRow = { _id: "w_other", slug: "other", source: "digraph o {}", serves: ["union.eval", "judge-review"], updated_at: 9 };
const flow = { _id: "lf_1", workflow_id: "w_spine", on: true };
const route = (o: Partial<Parameters<typeof flowRouteFor>[0]>) => flowRouteFor({ flow, spine, rows: [spine, system, judge, stranger], source: null, judge: false, ...o });

describe("flowRouteFor", () => {
  test("a source no member serves runs the spine", () => {
    expect(route({ source: "lesson" })).toMatchObject({ live_flow_id: "lf_1", lane: "spine", workflow: { _id: "w_spine" }, waiting: null });
    expect(route({ source: null })).toMatchObject({ lane: "spine", workflow: { _id: "w_spine" } });
  });

  test("a source the spine serves runs the spine, one a variant serves runs the variant", () => {
    expect(route({ source: "person" })).toMatchObject({ lane: "serves", workflow: { _id: "w_spine" } });
    expect(route({ source: " Union.Eval " })).toMatchObject({ lane: "serves", workflow: { _id: "w_system" } });
  });

  test("a variant by slug is family too; a row extending nothing is not", () => {
    expect(extendsFlow({ ...system, source: 'digraph s { graph [extends="agentwatch"] }' }, spine)).toBe(true);
    expect(extendsFlow({ ...system, source: 'digraph s { graph [extends="../line/agentwatch.cast"] }' }, spine)).toBe(true);
    expect(extendsFlow(stranger, spine)).toBe(false);
    expect(extendsFlow(spine, spine)).toBe(false);
  });

  test("a judge problem runs the member serving judge-review, whatever its source", () => {
    expect(route({ judge: true, source: "judge-review" })).toMatchObject({ lane: "judge", workflow: { _id: "w_judge" }, waiting: null });
  });

  test("a judge problem in a family with no judge member waits, never the spine", () => {
    // The stranger serves judge-review but is no library flow, so it is not the family's judge route.
    expect(flowRouteFor({ flow, spine, rows: [spine, system, stranger], source: "judge-review", judge: true })).toEqual({ live_flow_id: "lf_1", lane: "judge", workflow: null, waiting: NO_JUDGE_FLOW });
  });

  test("no live flow, a flow that is off, or a spine that is gone: no route, the runner's own versions decide", () => {
    expect(route({ flow: null, source: "person" })).toBeNull();
    expect(route({ flow: { ...flow, on: false }, source: "person" })).toBeNull();
    expect(route({ spine: null, source: "person" })).toBeNull();
    expect(route({ spine: system, source: "person" })).toBeNull();
  });
});
