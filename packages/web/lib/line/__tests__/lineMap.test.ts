import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { runVisits, type LineGraph, type MapRun } from "../lineMap";
import * as F from "./lineFixtures";

const { HOUR, DAY } = F;

describe("runVisits", () => {
  test("a revise round the run row overwrote comes back between red and reopen", () => {
    const v = runVisits(F.runA, SHIPPED_LINE, F.decisionsA);
    expect(v.map((x) => x.node)).toEqual([
      "ground", "analyze", "prove", "red",
      "implement", "verify", "eval", "review", "card_draft", "card_write", "card", "decide",
      "reopen", "implement", "verify", "eval", "review", "card_draft", "card_write", "card", "decide",
      "ship", "merge", "watch",
    ]);
    // The first round is inferred: no time of its own, dated by the next timed visit.
    const firstImpl = v.find((x) => x.node === "implement")!;
    expect(firstImpl.inferred).toBe(true);
    expect(firstImpl.startedAt).toBeNull();
    expect(firstImpl.at).toBe(F.runA.node_statuses!.find((n) => n.node_id === "reopen")!.started_at!);
    // A category prompt cause goes verify -> eval: the path prefers stations the run reached.
    expect(v.filter((x) => x.node === "green")).toHaveLength(0);
  });

  test("a gate answered with its key is done, not failed", () => {
    const decide = runVisits(F.runA, SHIPPED_LINE, F.decisionsA).filter((x) => x.node === "decide");
    expect(decide.map((x) => x.state)).toEqual(["done", "done"]);
  });

  test("a gate answered more often than the path shows gets its earlier rounds back", () => {
    const t = F.NOW - DAY;
    const run: MapRun = {
      _id: "run_plan", status: "running", task_id: "task_a", workflow_name: "line", current_node_id: "analyze",
      node_statuses: [F.n("ground", t), F.n("plan", t + 3 * F.HOUR, 20), F.n("plan_gate", t + 4 * F.HOUR, 30, "failed", { outcome: "A" }), F.n("analyze", t + 5 * F.HOUR, 0, "running")],
      created_at: t, updated_at: t + 5 * F.HOUR,
    };
    const asked = (id: string, at: number, answer: number) => ({ _id: id, status: "answered", blocking: true, workflow_run_id: "run_plan", gate_node_id: "plan_gate", created_at: at, options: [{ label: "Approve" }, { label: "Revise" }, { label: "Drop" }], answer_index: answer });
    const v = runVisits(run, SHIPPED_LINE, [asked("d1", t + HOUR, 1), asked("d2", t + 4 * F.HOUR, 0)]);
    expect(v.map((x) => `${x.node}${x.inferred ? "*" : ""}`)).toEqual(["ground", "plan", "plan_gate*", "plan*", "plan_gate", "analyze"]);
    expect(v[v.length - 1].state).toBe("live");
  });

  test("a live run whose current station has no status yet is at that station", () => {
    const run: MapRun = { ...F.runC, node_statuses: F.runC.node_statuses!.filter((n) => n.node_id !== "implement") };
    const v = runVisits(run, SHIPPED_LINE);
    expect(v[v.length - 1]).toMatchObject({ node: "implement", inferred: false });
  });
});
