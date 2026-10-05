import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { LINE_PHASES, causeWhere, gateAnswer, lineVersions, runOutcome, runPath, shortDay, type ReportRun } from "../runReport";

const T0 = 1_790_000_000_000;
const DAY = 86_400_000;
const n = (node_id: string, i: number, status = "completed", extra: Record<string, unknown> = {}) => ({ node_id, status, outcome: "success", started_at: T0 + i * 1000, completed_at: T0 + i * 1000 + 500, ...extra });

// ct-56750's shipped run, as the store holds it (node outcomes and all).
const shippedRun: ReportRun = {
  _id: "run1", status: "completed", task_id: "t1", current_node_id: "exit", graph_hash: "862f27511a65a9de",
  gate_node_id: "decide", gate_response: "S", gate_decision_short_id: "sd-389", gate_decision_status: "answered", gate_answer: "Ship", card_cost_usd: 1.25,
  gate_choices: [{ key: "S", label: "[S] Ship", target: "ship" }, { key: "R", label: "[R] Revise", target: "reopen" }, { key: "D", label: "[D] Drop", target: "drop" }],
  node_statuses: [
    n("start", 0), n("ground", 1, "completed", { session_id: "jx71x8m" }), n("analyze", 2), n("prove", 3), n("red", 4), n("implement", 5, "completed", { session_id: "jx75mhs" }),
    n("verify", 6), n("eval", 7), n("review", 8), n("card_draft", 9), n("card_write", 10), n("card", 11),
    n("decide", 12, "failed", { outcome: "s" }), n("ship", 13), n("merge", 14, "failed", { outcome: "failure" }), n("watch", 15), n("exit", 16),
  ],
  created_at: T0, updated_at: T0 + 20_000,
};

describe("phases", () => {
  test("every station of the shipped line sits in exactly one phase", () => {
    const stations = SHIPPED_LINE.nodes.map((x) => x.id).filter((id) => id !== "start" && id !== "exit");
    const placed = LINE_PHASES.flatMap((p) => p.stations);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...stations].sort()).toEqual([...placed].sort());
  });
});

describe("runPath", () => {
  const path = runPath(shippedRun, null, { status: "done", review_verdict: { verdict: "approve" } });
  const phase = (k: string) => path.find((p) => p.key === k)!;

  test("groups the stations it reached by phase and folds the rest", () => {
    expect(path.map((p) => p.key)).toEqual(["understand", "prove", "build", "check", "decide", "ship"]);
    expect(phase("understand").steps.map((s) => s.id)).toEqual(["ground", "analyze"]);
    expect(phase("understand").folded.map((s) => s.id).sort()).toEqual(["park", "plan", "plan_gate"]);
    expect(phase("prove").folded.map((s) => s.id)).toEqual(["dissolve"]);
  });

  test("a gate reads as its answer, never a raw key, and is not a failure", () => {
    const decide = phase("decide").steps.find((s) => s.id === "decide")!;
    expect(decide).toMatchObject({ state: "done", result: "Answered Ship" });
    expect(phase("decide").state).toBe("done");
  });

  test("each step says its result in one line and links the session that did it", () => {
    expect(phase("understand").steps[0]).toMatchObject({ result: "Tied the cause to a goal and rated it", session: { href: "/conversation/jx71x8m" } });
    expect(phase("check").steps.find((s) => s.id === "review")!.result).toBe("Review approved");
    const ship = phase("ship");
    expect(ship.steps.map((s) => [s.id, s.state, s.result])).toEqual([["ship", "done", "Landed the change"], ["merge", "failed", "Merge refused"], ["watch", "done", "Started the watch"]]);
    expect(ship.state).toBe("done");
  });

  test("a run waiting at its card says so", () => {
    const paused: ReportRun = { ...shippedRun, status: "paused", current_node_id: "decide", gate_answer: undefined, gate_response: undefined, node_statuses: shippedRun.node_statuses!.slice(0, 12) };
    const p = runPath(paused).find((x) => x.key === "decide")!;
    expect(p.steps.at(-1)).toMatchObject({ id: "decide", state: "waiting", result: "Waiting for an answer" });
    expect(p.state).toBe("waiting");
  });

  test("another workflow's run is one group of its steps", () => {
    const other: ReportRun = { _id: "r2", status: "completed", node_statuses: [n("start", 0), n("implement", 1)], created_at: T0, updated_at: T0 };
    const p = runPath(other);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ key: "steps", steps: [{ id: "implement", result: "Built the change" }] });
  });
});

describe("gateAnswer", () => {
  test("the decision's own option for the last gate, the key mirror for an earlier one", () => {
    expect(gateAnswer(shippedRun, { node_id: "decide", outcome: "s" })).toBe("Ship");
    const mirror = { gate_choices: [{ key: "A", label: "[A] Approve :: Build to this plan" }], gate_node_id: "decide", gate_answer: "Ship" };
    expect(gateAnswer(mirror, { node_id: "plan_gate", outcome: "a" })).toBe("Approve");
    expect(gateAnswer(mirror, { node_id: "plan_gate", outcome: "zz" })).toBeNull();
  });
});

describe("runOutcome", () => {
  const now = T0 + DAY;
  test("shipped says where the watch stands", () => {
    expect(runOutcome(shippedRun, { short_id: "ct-56750", status: "done", watch_until: T0 + 7 * DAY }, now).text).toBe(`Shipped. Watching ct-56750 until ${shortDay(T0 + 7 * DAY)}.`);
    expect(runOutcome(shippedRun, { status: "done", watch_until: null, resolved_at: T0 + 8 * DAY }, now).text).toBe("Shipped. The watch ended quiet.");
    expect(runOutcome(shippedRun, { status: "open" }, now)).toMatchObject({ tone: "failed", text: "Shipped, then reopened: its signal came back during the watch." });
  });

  test("the other ends, and a run still going", () => {
    const ends = (ids: string[], extra: Partial<ReportRun> = {}) => ({ ...shippedRun, ...extra, node_statuses: [n("ground", 1), ...ids.map((id, i) => n(id, i + 2))] });
    expect(runOutcome(ends(["decide", "drop"])).text).toBe("Dropped at the card.");
    expect(runOutcome(ends(["plan_gate", "drop"])).text).toBe("Dropped at the plan.");
    expect(runOutcome(ends(["prove", "dissolve"])).text).toBe("Closed without a change: the miss did not reproduce.");
    expect(runOutcome(ends(["park"]), { status: "open", readiness_note: "No goal named" }).text).toBe("Parked: the cause is not ready to build. No goal named.");
    expect(runOutcome({ ...shippedRun, status: "running", current_node_id: "implement" }).text).toBe("Working: at Implement.");
    expect(runOutcome({ ...shippedRun, status: "paused", gate_node_id: "decide" }).text).toBe("Waiting for an answer on the card.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove" }).text).toBe("Stopped at Prove: no outgoing edge from prove.");
    expect(runOutcome({ ...shippedRun, status: "failed", fail_reason: "Stopped: the cause was dropped by a person" }).text).toBe("Stopped: the cause was dropped by a person.");
  });
});

describe("lineVersions", () => {
  test("one row per graph: runs, shipped, revised, dropped, reopened after ship, cost", () => {
    const revised: ReportRun = { ...shippedRun, _id: "r3", task_id: "t3", node_statuses: [...shippedRun.node_statuses!, n("reopen", 13)], card_cost_usd: 0.75, created_at: T0 + 5 };
    const dropped: ReportRun = { ...shippedRun, _id: "r4", task_id: "t4", graph_hash: "aaaa", card_cost_usd: undefined, node_statuses: [n("ground", 1), n("decide", 2), n("drop", 3)], created_at: T0 - 5 };
    const notLine: ReportRun = { _id: "r5", status: "completed", node_statuses: [n("implement", 1)], created_at: T0, updated_at: T0 };
    const reopened = (task: string) => (task === "t1" ? [T0 + 99_000] : []);
    const rows = lineVersions([shippedRun, revised, dropped, notLine], reopened);
    expect(rows).toEqual([
      { hash: "862f27511a65a9de", first: T0, last: T0 + 5, runs: 2, shipped: 2, revised: 1, dropped: 0, reopened: 1, costUsd: 2, live: 0 },
      { hash: "aaaa", first: T0 - 5, last: T0 - 5, runs: 1, shipped: 0, revised: 0, dropped: 1, reopened: 0, costUsd: null, live: 0 },
    ]);
  });
});

describe("causeWhere", () => {
  const now = T0 + DAY;
  test("the run speaks while it runs; the status and the watch after", () => {
    expect(causeWhere({ status: "in_review" }, { ...shippedRun, status: "paused", gate_node_id: "decide" }, false, now).text).toBe("Waiting for an answer on the card.");
    expect(causeWhere({ status: "done", watch_until: T0 + 7 * DAY }, shippedRun, false, now).text).toBe(`Shipped. Watching until ${shortDay(T0 + 7 * DAY)}.`);
    expect(causeWhere({ status: "open" }, shippedRun, true, now).text).toBe("Reopened: its signal came back during the watch.");
    expect(causeWhere({ status: "open" }, null, false, now).text).toBe("Waiting to be admitted.");
    expect(causeWhere({ status: "dropped" }, shippedRun, false, now).text).toBe("Dropped.");
  });
});
