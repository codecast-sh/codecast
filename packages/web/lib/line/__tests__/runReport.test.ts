import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { union57382Run, union57467Run } from "./unionLineRuns.fixture";
import { ct57659Run2, ct57659Run3, ct57659Run5 } from "./ct57659Runs.fixture";
import { LINE_PHASES, approvalScope, closedDecisionWords, cardName, fileStepLabel, plainStepWords, stepLabel, causeRunEntries, causeWhere, gateAnswer, lineVersions, projectLineVersions, runEnd, runOutcome, runPath, scriptLine, shortDay, stationWords, versionChange, type ReportRun } from "../runReport";

const T0 = 1_790_000_000_000;
const HOUR = 3_600_000;
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
    // merge stays placed for runs from before the line dropped it.
    const placed = LINE_PHASES.flatMap((p) => p.stations).filter((id) => id !== "merge");
    expect(new Set(placed).size).toBe(placed.length);
    expect([...stations].sort()).toEqual([...placed].sort());
  });
});

describe("runPath", () => {
  const path = runPath(shippedRun, null, { short_id: "ct-56750", status: "done", review_verdict: { verdict: "approve" } });
  const phase = (k: string) => path.find((p) => p.key === k)!;

  test("groups the stations it reached by phase and folds the rest", () => {
    expect(path.map((p) => p.key)).toEqual(["understand", "prove", "build", "check", "decide", "ship"]);
    expect(phase("understand").steps.map((s) => s.id)).toEqual(["ground", "analyze"]);
    expect(phase("understand").folded.map((s) => s.id).sort()).toEqual(["park", "plan", "plan_gate"]);
    expect(phase("prove").folded.map((s) => s.id)).toEqual(["prove_line", "dissolve"]);
  });

  test("a gate reads as its answer, never a raw key, and is not a failure", () => {
    const decide = phase("decide").steps.find((s) => s.id === "decide")!;
    // The decision's key stays behind the link; who answered is named when known.
    // An approval names what it covered: the card's Ship approved shipping the fix.
    expect(decide).toMatchObject({ state: "done", result: "Approved shipping this fix", href: "/decisions/sd-389" });
    expect(runPath(shippedRun, null, null, { answeredBy: "Ashot Petrosian" }).find((p) => p.key === "decide")!.steps[0].result).toBe("Ashot Petrosian approved shipping this fix");
    expect(phase("decide").state).toBe("done");
  });

  test("the steps that only assemble the card fold, so Decide reads by its answer", () => {
    expect(phase("decide").steps.map((s) => s.id)).toEqual(["decide"]);
    expect(phase("decide").routine.map((s) => s.id)).toEqual(["card_draft", "card_write", "card"]);
    const refused: ReportRun = { ...shippedRun, node_statuses: shippedRun.node_statuses!.map((x) => (x.node_id === "card" ? { ...x, status: "failed" } : x)) };
    expect(runPath(refused).find((p) => p.key === "decide")!.steps.map((s) => s.id)).toContain("card");
  });

  test("each step says its result in one line and links the session that did it", () => {
    expect(phase("understand").steps[0]).toMatchObject({ label: "Check against goals", result: "Tied the problem to a goal and rated it", href: "/conversation/jx71x8m" });
    // Every step is named by its station, even when its result says it too.
    expect(phase("check").steps.map((s) => s.label)).toEqual(["Verify", "Eval", "Review"]);
  });

  test("ship, merge and watch are one row that says whether the change landed; a merge left to a person did not land", () => {
    const ship = phase("ship");
    expect(ship.steps.map((s) => [s.id, s.state])).toEqual([["ship", "done"]]);
    expect(ship.steps[0]).toMatchObject({ label: "Ship", note: "the line could not merge it", href: "/tasks/ct-56750" });
    expect(ship.steps[0].result).toMatch(/^Landed by hand \w+ \d+$/);
    expect(ship.state).toBe("done");
    const open = runPath(shippedRun, null, { status: "in_progress" }).find((p) => p.key === "ship")!;
    expect(open.steps).toHaveLength(1);
    expect(open.steps[0]).toMatchObject({ id: "ship", state: "noted", result: "Not landed: left to a person to land" });
    const merged: ReportRun = { ...shippedRun, node_statuses: shippedRun.node_statuses!.map((x) => (x.node_id === "merge" ? { ...x, status: "completed", outcome: "success" } : x)) };
    expect(runPath(merged).find((p) => p.key === "ship")!.steps).toMatchObject([{ id: "ship", state: "done", result: "Landed", note: "watching for the problem to come back" }]);
  });

  test("a run waiting at its card says so", () => {
    const paused: ReportRun = { ...shippedRun, status: "paused", current_node_id: "decide", gate_answer: undefined, gate_response: undefined, node_statuses: shippedRun.node_statuses!.slice(0, 12) };
    const p = runPath(paused).find((x) => x.key === "decide")!;
    expect(p.steps.at(-1)).toMatchObject({ id: "decide", state: "waiting", result: "Waiting for an answer" });
    expect(p.state).toBe("waiting");
  });

  test("a card taken back, a run cut off, a station interrupted: none reads as a failure or as under way", () => {
    const upToCard = shippedRun.node_statuses!.slice(0, 12);
    // The card was withdrawn and the run routed on: Decide asked, Ship never ran.
    const withdrawn: ReportRun = { ...shippedRun, gate_answer: undefined, gate_response: undefined, gate_decision_status: "withdrawn", node_statuses: [...upToCard, n("decide", 12, "failed", { outcome: "failure" }), n("ship", 13, "failed", { outcome: "failure" })] };
    const steps = runPath(withdrawn).flatMap((p) => p.steps);
    expect(steps.find((s) => s.id === "decide")).toMatchObject({ state: "noted", result: "Asked; the card was withdrawn" });
    expect(steps.find((s) => s.id === "ship")).toMatchObject({ state: "noted", result: "Not landed: the decision was withdrawn" });
    expect(runOutcome(withdrawn)).toMatchObject({ tone: "closed", text: "Stopped: the decision was withdrawn." });
    // The run failed while its gate row still says running: finished, not live.
    const cut: ReportRun = { ...withdrawn, status: "failed", current_node_id: "decide", fail_reason: "gate withdrawn", node_statuses: [...upToCard, n("decide", 12, "running", { outcome: undefined })] };
    expect(runPath(cut).flatMap((p) => p.steps).find((s) => s.id === "decide")?.state).toBe("noted");
    // Stopped by hand at Red: Red gave no verdict.
    const sigint: ReportRun = { ...shippedRun, status: "failed", current_node_id: "red", fail_reason: "the runner was stopped (SIGINT) at red", gate_answer: undefined, node_statuses: [...shippedRun.node_statuses!.slice(0, 4), n("red", 4, "failed", { outcome: undefined })] };
    expect(runPath(sigint).flatMap((p) => p.steps).find((s) => s.id === "red")).toMatchObject({ state: "noted", result: "Interrupted before it finished" });
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
    const day = shortDay(T0);
    expect(runOutcome(shippedRun, { short_id: "ct-56750", status: "done", watch_until: T0 + 7 * DAY }, now).text).toBe(`Shipped by hand ${day} after the line could not merge it. Watching for the problem to come back until ${shortDay(T0 + 7 * DAY)}.`);
    expect(runOutcome(shippedRun, { status: "done", watch_until: null, resolved_at: T0 + 8 * DAY }, now).text).toBe(`Shipped by hand ${day} after the line could not merge it. The watch ended quiet.`);
    expect(runOutcome(shippedRun, { status: "open" }, now)).toMatchObject({ tone: "failed", text: `Shipped ${day}, then reopened: the problem came back during the watch.` });
  });

  test("a row says what the run did, without its day, the watch or the task", () => {
    expect(runOutcome(shippedRun, { short_id: "ct-56750", status: "done", watch_until: T0 + 7 * DAY }, now, true).text).toBe("Shipped by hand.");
    expect(runOutcome(shippedRun, { status: "in_progress" }, now, true).text).toBe("Shipped.");
  });

  test("the other ends, and a run still going", () => {
    // A run that stopped never completed its watch.
    const stopped = { ...shippedRun, node_statuses: shippedRun.node_statuses!.filter((x) => x.node_id !== "watch") };
    const ends = (ids: string[], extra: Partial<ReportRun> = {}) => ({ ...shippedRun, ...extra, node_statuses: [n("ground", 1), ...ids.map((id, i) => n(id, i + 2))] });
    expect(runOutcome(ends(["decide", "drop"])).text).toBe("Dropped at your decision.");
    expect(runOutcome(ends(["plan_gate", "drop"])).text).toBe("Dropped at the plan.");
    expect(runOutcome(ends(["prove", "dissolve"])).text).toBe("Closed without a change: the problem did not reproduce.");
    expect(runOutcome(ends(["park"]), { status: "open", readiness_note: "No goal named" }).text).toBe("Parked: the problem is not ready to build. No goal named.");
    expect(runOutcome({ ...shippedRun, status: "running", current_node_id: "implement" }).text).toBe("Working: at Implement.");
    expect(runOutcome({ ...shippedRun, status: "paused", gate_node_id: "decide" }).text).toBe("Waiting for your decision.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)" }).text).toBe("Stopped at Prove: Prove finished, and the line has no route for that result yet.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome failure, review_verdict none)" }).text).toBe("Stopped at Prove: Prove failed outright, and the line has no route for that yet.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "prove", fail_reason: "max_visits=2 exceeded on prove" }).text).toBe("Stopped: Prove looped twice.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "implement", fail_reason: "max_visits=3 exceeded on implement" }).text).toBe("Stopped: Implement looped three times.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "prove", fail_reason: "hand jx79xc0 killed after 30m at prove" }).text).toBe("Stopped: Prove's session ran out of time.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "decide", fail_reason: "gate withdrawn" }).text).toBe("Stopped: the decision was withdrawn.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "plan_gate", gate_node_id: "plan_gate", fail_reason: "gate withdrawn" }).text).toBe("Stopped: the question was withdrawn.");
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "red", fail_reason: "the runner was stopped (SIGINT) at red" })).toMatchObject({ tone: "closed", text: "Stopped by hand during Confirm the test fails." });
    expect(runOutcome({ ...stopped, status: "failed", current_node_id: "verify", fail_reason: "checks timed out" }).text).toBe("Stopped at Verify: checks timed out.");
    expect(runOutcome({ ...stopped, status: "failed", fail_reason: "Stopped: the problem was dropped by a person" }).text).toBe("Stopped: the problem was dropped by a person.");
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
      { hash: "862f27511a65a9de", first: T0, last: T0 + 5, runs: 2, shipped: 2, revised: 1, dropped: 0, stopped: 0, reopened: 1, costUsd: 2, live: 0, nodes: null, change: "Edited; which stations was not recorded yet" },
      { hash: "aaaa", first: T0 - 5, last: T0 - 5, runs: 1, shipped: 0, revised: 0, dropped: 1, stopped: 0, reopened: 0, costUsd: null, live: 0, nodes: null, change: "First recorded version" },
    ]);
  });

  test("a run that stopped before an answer counts as stopped, so every run is accounted for", () => {
    const stopped: ReportRun = { ...shippedRun, _id: "r6", status: "failed", gate_answer: undefined, node_statuses: [n("ground", 1), n("prove", 2, "failed")], created_at: T0 - 9 };
    const [row] = lineVersions([shippedRun, stopped], () => []);
    expect(row).toMatchObject({ runs: 2, shipped: 1, stopped: 1 });
  });

  test("each version says which stations it changed from the one before", () => {
    const a = [{ id: "prove", h: "11" }, { id: "review", h: "22" }, { id: "unscored", h: "33" }];
    expect(versionChange(a, undefined)).toBe("First recorded version");
    expect(versionChange([{ id: "prove", h: "19" }, { id: "review", h: "22" }, { id: "unscored", h: "33" }], a)).toBe("Prove edited");
    expect(versionChange([{ id: "prove", h: "11" }, { id: "review", h: "29" }, { id: "eval", h: "44" }], a)).toBe("Review edited, Eval added, Unscored removed");
    expect(versionChange(a, a)).toBe("Line settings edited");
    expect(versionChange(a, null)).toBe("Edited; which stations was not recorded yet");
    const v1: ReportRun = { ...shippedRun, _id: "v1", graph_hash: "h1", graph_nodes: a, created_at: T0 };
    const v2: ReportRun = { ...shippedRun, _id: "v2", graph_hash: "h2", graph_nodes: [{ id: "prove", h: "19" }, { id: "review", h: "22" }, { id: "unscored", h: "33" }], created_at: T0 + DAY };
    expect(lineVersions([v2, v1], () => []).map((v) => v.change)).toEqual(["Prove edited", "First recorded version"]);
  });
});

describe("projectLineVersions: what each version delivered", () => {
  const at = (id: string, hash: string, nodes: Array<{ id: string; h: string }>, day: number, extra: Partial<ReportRun> = {}): ReportRun =>
    ({ ...shippedRun, _id: id, graph_hash: hash, graph_nodes: nodes, created_at: T0 + day * DAY, ...extra });
  const v1 = at("v1", "h1", [{ id: "prove", h: "p1" }, { id: "review", h: "r1" }], 0);
  const v2 = at("v2", "h2", [{ id: "prove", h: "p1" }, { id: "review", h: "r2" }], 1, { status: "failed", gate_answer: undefined, node_statuses: [n("ground", 1), n("prove", 2, "failed")] });
  const v3 = at("v3", "h3", [{ id: "prove", h: "p2" }, { id: "review", h: "r2" }], 2);

  test("a reopened signal after the ship counts against its version", () => {
    const [row] = projectLineVersions({ runs: [v1], signals: [{ task_id: "t1", reopened: true, created_at: T0 + 99_000 }] });
    expect(row.reopened).toBe(1);
  });
});

describe("causeWhere", () => {
  const now = T0 + DAY;
  test("the run speaks while it runs; the status and the watch after", () => {
    expect(causeWhere({ status: "in_review" }, { ...shippedRun, status: "paused", gate_node_id: "decide" }, false, now).text).toBe("Waiting for your decision.");
    // A shipped cause reads as its run's outcome does: one sentence, one day.
    const task = { status: "done", watch_until: T0 + 7 * DAY };
    expect(causeWhere(task, shippedRun, false, now).text).toBe(runOutcome(shippedRun, task, now).text);
    expect(causeWhere(task, null, false, now).text).toBe(`Shipped. Watching for the problem to come back until ${shortDay(T0 + 7 * DAY)}.`);
    expect(causeWhere({ status: "open" }, shippedRun, true, now).text).toMatch(/^Shipped \w+ \d+, then reopened: the problem came back during the watch\.$/);
    expect(causeWhere({ status: "open" }, null, false, now).text).toBe("Waiting its turn.");
    // A line that starts nothing is no queue: it says why, never "waiting its turn".
    expect(causeWhere({ status: "open" }, null, false, now, "@agent-quality's line is off").text).toBe("Not started: @agent-quality's line is off.");
    expect(causeWhere({ status: "dropped" }, null, false, now, "@agent-quality's line is off").text).toBe("Dropped.");
    expect(causeWhere({ status: "dropped" }, shippedRun, false, now).text).toBe("Dropped.");
  });
});

describe("a run that went on past its withdrawn card (ct-58022)", () => {
  const now = T0 + DAY;
  // AgentWatch: an earlier approval of the proposal let the build start; the card's gate then timed out unanswered and the runner went on.
  const ids = ["start", "bind", "propose", "approve_carried", "build", "card", "decide", "ship", "merge", "watch", "exit"];
  const run: ReportRun = {
    _id: "aw2", status: "completed", workflow_name: "agentwatch", current_node_id: "exit", gate_node_id: "decide", gate_decision_status: "withdrawn", created_at: T0, updated_at: T0 + 20,
    node_statuses: ids.map((id, i) => ({ node_id: id, status: id === "decide" ? "failed" : "completed", outcome: id === "decide" ? "failure" : "success", started_at: T0 + i, completed_at: T0 + i + 1 })),
  };
  const task = { status: "open", watch_until: T0 + 7 * DAY };
  test("every surface says not shipped, never shipped and never waiting to be admitted", () => {
    expect(runEnd(run)).toBeNull();
    expect(runOutcome(run, task, now).text).toMatch(/^Not shipped: the run went on past a card nobody answered/);
    expect(causeWhere(task, run, false, now).text).toBe(runOutcome(run, task, now).text);
    const steps = runPath(run).flatMap((p) => p.steps);
    // Ship, merge and watch read as one row that says the change did not land.
    expect(steps.filter((x) => ["ship", "merge", "watch"].includes(x.id))).toEqual([expect.objectContaining({ id: "ship", state: "noted", result: "Not landed: it ran without an approval, since nobody answered the card before it" })]);
  });
});

describe("causeRunEntries", () => {
  const failed = (id: string, at: number, nodes: string[]): ReportRun => ({ ...shippedRun, _id: id, status: "failed", created_at: at, node_statuses: nodes.map((x, i) => n(x, i)) });
  test("every run is its own row; a stopped run a later run followed is superseded", () => {
    const runs = [
      { ...shippedRun, created_at: T0 + 10 },
      failed("a", T0 + 5, ["ground", "prove"]), failed("b", T0 + 4, ["ground", "prove"]), failed("c", T0 + 3, ["ground", "prove"]),
    ];
    const e = causeRunEntries(runs);
    expect(e.map((x) => x.run._id)).toEqual([shippedRun._id, "a", "b", "c"]);
    expect(e.map((x) => x.superseded)).toEqual([false, true, true, true]);
  });
  test("the newest failure is not superseded; a list without its newest run is measured against it", () => {
    expect(causeRunEntries([failed("a", T0 + 5, ["prove"]), failed("b", T0 + 4, ["prove"])]).map((x) => x.superseded)).toEqual([false, true]);
    expect(causeRunEntries([failed("a", T0 + 5, ["prove"]), failed("b", T0 + 4, ["prove"])], T0 + 10).map((x) => x.superseded)).toEqual([true, true]);
  });
});

describe("words a reader meets", () => {
  test("a card is named by what it decided, never by its key", () => {
    expect(cardName("Ship", { headline: "Insight lists only finished steps." }, false)).toBe("Ship: Insight lists only finished steps");
    expect(cardName("Ship", { change: "The prompt lists only finished steps. It calls a session shipped only when deployed." }, false)).toBe("Ship: The prompt lists only finished steps");
    expect(cardName("Ship", null, false)).toBe("Answered Ship");
    expect(cardName(null, { headline: "Insight lists only finished steps" }, true)).toBe("Waiting for an answer: Insight lists only finished steps");
  });
  test("every station says what it does", () => {
    const all = LINE_PHASES.flatMap((p) => p.stations);
    for (const id of all) expect(stationWords(id)).toBeTruthy();
    // No insider word for the cause.
    for (const id of all) expect(stationWords(id)).not.toMatch(/\bmiss\b/);
  });
});

describe("a station's words are what it reported (Union's AgentWatch line, 2026-10-07)", () => {
  const step = (run: ReportRun, id: string) => runPath(run).flatMap((p) => p.steps).find((s) => s.id === id)!;

  test("a dissolve that passed the cluster on says so, never that it closed it", () => {
    for (const run of [union57382Run, union57467Run]) {
      expect(step(run, "dissolve").result).toBe("Passed it on: the problem needs its own fix");
    }
  });

  test("a prove that proved its cause reads as proved, though the run stopped after it", () => {
    const prove = step(union57382Run, "prove");
    expect(prove.state).not.toBe("failed");
    expect(prove.result).toStartWith("C116 is proven");
  });

  test("a station that pinned a question reads as its question", () => {
    expect(step(union57467Run, "refine").result).toStartWith("Refine stopped: the missed-call cause (C115)");
  });
});

describe("scriptLine", () => {
  test("a check's routing JSON reads as its why, or as nothing so the station's words stand", () => {
    expect(scriptLine('{"red": true, "dir": "/x/.git/cast-line/line-ct-1", "why": "repro.sh fails"}')).toBe("repro.sh fails");
    expect(scriptLine('{"dissolved": "no_repro"} ok Completed ct-1')).toBeUndefined();
    expect(scriptLine("applied to the working tree: 2 files changed")).toBe("applied to the working tree: 2 files changed");
    expect(scriptLine(undefined)).toBeUndefined();
  });

  test("an agent's structured result reads as its summary or verdict, even when its preview was cut mid-object", () => {
    expect(scriptLine('{"summary":"WP1 is built: the Org screen,\\n\\nthe role page and the goal pa')).toBe("WP1 is built: the Org screen, the role page and the goal pa…");
    expect(scriptLine('{"verdict":"NEEDS_CHANGES","issues":[{"file":"/Users/x/src/a.ts","line":4')).toBe("Needs changes");
    expect(scriptLine('{"verdict":"PASS","issues":[{"file":"a.ts"},{"file":"b.ts"}]}')).toBe("Passed: 2 issues");
    expect(scriptLine('{"verdict":"NEEDS_CHANGES","summary":"Two bugs in the sheet."}')).toBe("Needs changes. Two bugs in the sheet.");
  });

  test("a reviewer's findings read as the first one's words, an integrator's notes as notes, any other schema as its first sentence", () => {
    expect(scriptLine('{"verdict":"NEEDS_CHANGES","findings":[{"severity":"major","issue":"The page still picks members differently fro')).toBe("Needs changes. The page still picks members differently fro…");
    expect(scriptLine('{"verdict":"NEEDS_CHANGES","findings":[{"severity":"major","issue":"Gap after merge."},{"issue":"b"}]}')).toBe("Needs changes: 2 findings. Gap after merge.");
    expect(scriptLine('{"applied":true,"notes":"G6-expand-first is integrated, committed as f0c57b88ab \\"G6-expand-first\\" in /Users/as')).toBe('G6-expand-first is integrated, committed as f0c57b88ab "G6-expand-first" in /Users/as…');
    expect(scriptLine('{"status":"done","summary":"Both findings were right, and both are fixed. Main moved')).toBe("Both findings were right, and both are fixed. Main moved…");
    expect(scriptLine('{"ok":true,"kind":"x","detail":"Ran the three checks."}')).toBe("Ran the three checks.");
  });
});

describe("a Workflow tool run", () => {
  test("a completed run says it finished, never which agent happened to finish last", () => {
    const run: ReportRun = { _id: "r", status: "completed", run_kind: "workflow", current_node_id: "polish:10", phases: [{ title: "Build" }, { title: "Polish" }], node_statuses: [n("build:WP1", 0), n("review:WP1#1", 1), n("polish:10", 2)], created_at: T0, updated_at: T0 + HOUR };
    expect(runOutcome(run).text).toBe("Finished all 2 phases.");
    expect(runOutcome({ ...run, phases: undefined }).text).toBe("Finished.");
  });
});

describe("a station's words are what happened to it (ct-57659's runs, 2026-10-07)", () => {
  const step = (run: ReportRun, id: string) => runPath(run).flatMap((p) => p.steps).find((s) => s.id === id)!;

  test("a station whose session was killed before it began never started", () => {
    expect(step(ct57659Run2, "prove_line").result).toBe("Never started: queued, then killed before it began");
    expect(runOutcome(ct57659Run2).text).toBe("Stopped at Prove line: Prove line never started (it was queued, then killed).");
  });

  test("a builder that handed off needs_context stopped to ask, it did not fail outright", () => {
    expect(step(ct57659Run3, "implement_line").result).toBe("Handed off needs_context: stopped to ask for context");
    expect(runOutcome(ct57659Run3).text).toBe("Stopped at Build line: Build line stopped to ask for context (a needs_context handoff), and the line had no route for that.");
  });

  test("script stations read as one sentence, never their raw output", () => {
    for (const run of [ct57659Run3, ct57659Run5]) {
      expect(step(run, "verify").result).toBe("No checks ran: the project names no check command");
      expect(step(run, "green").result).toBe("The test passes with the change");
      expect(step(run, "eval").result).toBe("No evals ran: the change touches no eval surface");
      expect(step(run, "red").result).toBe("repro.sh fails");
    }
  });

  test("a script station's JSON reads as its why; a station that pinned blocked waits on a person", () => {
    const run = (preview: string): ReportRun => ({ ...ct57659Run5, node_statuses: ct57659Run5.node_statuses!.map((n) => (n.node_id === "green" ? { ...n, result_preview: preview } : n)) });
    expect(step(run('{"green": false, "why": "the reproduction still fails"}'), "green").result).toBe("The reproduction still fails");
    expect(step(run('{"card": {"cause": {"task": "ct-57659", "title": "When Prove fa'), "green").result).toBe("The test passes with the change");
    expect(runOutcome({ ...ct57659Run3, fail_reason: "implement_line is waiting on a person" }).text).toBe("Stopped at Build line: it asked a question and waits on a person's answer.");
  });
});

describe("a retired station keeps its own words", () => {
  test("a station that finished and was then retired (killed) is not read as killed", () => {
    const run: ReportRun = { ...ct57659Run5, node_statuses: ct57659Run5.node_statuses!.map((n) => (n.node_id === "analyze" ? { ...n, session: { _id: "jx77tqg", killed: true, message_count: 11 } } : n)) };
    expect(runPath(run).flatMap((p) => p.steps).find((s) => s.id === "analyze")!.result).toBe("Read the problem and its reports");
  });
});

describe("plain step names", () => {
  test("a shop-talk step is named in plain words everywhere, its graph file's own label kept as the subtitle", () => {
    expect(stepLabel({ id: "shared", label: "Shared text" })).toBe("Prepare the shared text");
    expect(stepLabel({ id: "stamp", label: "Stamp" })).toBe("Record the problem");
    expect(stepLabel({ id: "red", label: "Red" })).toBe("Confirm the test fails");
    expect(stepLabel({ id: "red" })).toBe("Confirm the test fails");
    // A step with plain words already keeps its own.
    expect(stepLabel({ id: "investigate", label: "Investigate" })).toBe("Investigate");
    expect(fileStepLabel("stamp", "Stamp")).toBe("Stamp");
    expect(fileStepLabel("investigate", "Investigate")).toBeNull();
    expect(fileStepLabel("red", undefined)).toBeNull();
    expect(plainStepWords("card refused")).toBe("report refused");
    expect(plainStepWords("no miss shown")).toBe("the test didn't fail first, so retry");
  });

  test("a run that ends at another graph's own end step says where", () => {
    const foreign = (current: string): ReportRun => ({ ...shippedRun, status: "completed", current_node_id: current, node_statuses: [{ node_id: "build", label: "Build", status: "completed" }, { node_id: current, label: "Failed", status: "completed" }] as any });
    expect(runOutcome(foreign("failed_at_build")).text).toBe("Stopped: Build failed.");
    expect(runOutcome(foreign("dissolved_at_build")).text).toBe("Closed without a change at Build.");
    // A run that reached the exit names the last step it passed.
    expect(runOutcome({ ...foreign("escalated_at_build"), current_node_id: "exit" }).text).toBe("Handed to a person at Build.");
    // A step the run's own record does not label is named from its id, never the exit's label.
    expect(runOutcome({ ...shippedRun, status: "completed", current_node_id: "exit", current_node_label: "Exit", node_statuses: [{ node_id: "escalated_at_refine", label: "Escalated", status: "completed" }] as any }).text).toBe("Handed to a person at Refine.");
  });
});

describe("runOutcome on another graph (AgentWatch)", () => {
  test("a run that merged and started its watch shipped, even when its card was withdrawn and the runner ended failed", () => {
    const run = {
      _id: "run_aw", status: "failed", current_node_id: "decide", gate_node_id: "decide", gate_decision_status: "withdrawn", fail_reason: "gate withdrawn",
      created_at: T0, updated_at: T0 + 3 * HOUR,
      node_statuses: ["bind", "investigate", "build", "decide", "ship", "merge", "watch"].map((id, i) => ({ node_id: id, status: "completed", started_at: T0 + i * HOUR, completed_at: T0 + i * HOUR + 1 })),
    } as ReportRun;
    expect(runEnd(run)?.kind).toBe("shipped");
    expect(runOutcome(run, null, T0, true).text).toBe("Shipped.");
  });

  test("a run that went on past a card nobody answered did not ship, though ship, merge and watch report success (ct-58022)", () => {
    const step = (id: string, i: number, status = "completed") => ({ node_id: id, status, outcome: status === "failed" ? "failure" : "success", started_at: T0 + i * HOUR, completed_at: T0 + i * HOUR + 1 });
    const run = {
      _id: "run_58022", status: "completed", current_node_id: "exit", created_at: T0, updated_at: T0 + 6 * HOUR,
      node_statuses: [step("build", 0), step("card", 1), step("decide", 2, "failed"), step("ship", 3), step("merge", 4), step("watch", 5), step("exit", 6)],
    } as ReportRun;
    expect(runEnd(run)).toBeNull();
    expect(runOutcome(run, { status: "done", watch_until: T0 + 7 * 24 * HOUR } as any, T0).text).toMatch(/^Not shipped: the run went on past a card nobody answered/);
  });
});

describe("what an approval covered", () => {
  test("a proposal's approval approved building the fix, never a ship; the card's Ship approved shipping it", () => {
    expect(approvalScope("proposal_gate", "Approve")).toBe("Approved building this fix");
    expect(approvalScope("plan_gate", "[A] Approve")).toBe("Approved the plan");
    expect(approvalScope("decide", "Ship")).toBe("Approved shipping this fix");
    expect(approvalScope("decide", "Revise")).toBeNull();
    expect(approvalScope(undefined, "Approve")).toBeNull();
  });

  test("a run's proposal gate row says what its approval covered", () => {
    const run: ReportRun = { _id: "p1", status: "running", current_node_id: "build", workflow_name: "agentwatch", created_at: T0, updated_at: T0,
      node_statuses: [n("propose", 0), n("proposal_gate", 1, "completed", { outcome: "approve" }), n("build", 2, "running")] };
    expect(runPath(run).flatMap((p) => p.steps).find((s) => s.id === "proposal_gate")?.result).toBe("Approved building this fix");
  });
});

describe("a decision closed without an answer", () => {
  const T = 1_790_000_000_000;
  test("a card whose run stopped waiting says so in plain words, never that the agent withdrew it, and offers to ask again", () => {
    const run: ReportRun = { _id: "r", status: "completed", created_at: T, updated_at: T, gate_decision_status: "withdrawn",
      node_statuses: [{ node_id: "decide", status: "failed", outcome: "failure", started_at: T, completed_at: T + 3 * 3_600_000 + 12 * 60_000 }, { node_id: "ship", status: "completed", started_at: T + 4 * 3_600_000, completed_at: T + 4 * 3_600_000 + 1 }] };
    const w = closedDecisionWords("withdrawn", run);
    expect(w.headline).toBe("Withdrawn: the run stopped waiting after 3h 12m; it was never answered");
    expect(w.detail).toMatch(/built but not shipped/);
    expect(w.askAgain).toBe(true);
    expect(`${w.headline} ${w.detail}`).not.toMatch(/by the agent/);
  });

  test("a decision with no run is withdrawn or dismissed, and nobody needs to answer it", () => {
    expect(closedDecisionWords("withdrawn", null)).toEqual({ headline: "Withdrawn before anyone answered it", detail: "Nobody needs to answer it now.", askAgain: false });
    expect(closedDecisionWords("dismissed", null).headline).toBe("Dismissed without an answer");
  });
});
