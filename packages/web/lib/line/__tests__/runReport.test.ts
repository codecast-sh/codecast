import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { LINE_PHASES, cardName, causeRunEntries, causeWhere, gateAnswer, isMainStation, lineVersions, projectLineVersions, runOutcome, runPath, shortDay, stationHistory, stationWords, versionChange, type ReportRun } from "../runReport";

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
  const path = runPath(shippedRun, null, { short_id: "ct-56750", status: "done", review_verdict: { verdict: "approve" } });
  const phase = (k: string) => path.find((p) => p.key === k)!;

  test("groups the stations it reached by phase and folds the rest", () => {
    expect(path.map((p) => p.key)).toEqual(["understand", "prove", "build", "check", "decide", "ship"]);
    expect(phase("understand").steps.map((s) => s.id)).toEqual(["ground", "analyze"]);
    expect(phase("understand").folded.map((s) => s.id).sort()).toEqual(["park", "plan", "plan_gate"]);
    expect(phase("prove").folded.map((s) => s.id)).toEqual(["dissolve"]);
  });

  test("a gate reads as its answer, never a raw key, and is not a failure", () => {
    const decide = phase("decide").steps.find((s) => s.id === "decide")!;
    // The decision's key stays behind the link; who answered is named when known.
    expect(decide).toMatchObject({ state: "done", result: "Answered Ship", href: "/decisions/sd-389" });
    expect(runPath(shippedRun, null, null, { answeredBy: "Ashot Petrosian" }).find((p) => p.key === "decide")!.steps[0].result).toBe("Ashot Petrosian answered Ship");
    expect(phase("decide").state).toBe("done");
  });

  test("the steps that only assemble the card fold, so Decide reads by its answer", () => {
    expect(phase("decide").steps.map((s) => s.id)).toEqual(["decide"]);
    expect(phase("decide").routine.map((s) => s.id)).toEqual(["card_draft", "card_write", "card"]);
    const refused: ReportRun = { ...shippedRun, node_statuses: shippedRun.node_statuses!.map((x) => (x.node_id === "card" ? { ...x, status: "failed" } : x)) };
    expect(runPath(refused).find((p) => p.key === "decide")!.steps.map((s) => s.id)).toContain("card");
  });

  test("each step says its result in one line and links the session that did it", () => {
    expect(phase("understand").steps[0]).toMatchObject({ label: "Ground", result: "Tied the cause to a goal and rated it", href: "/conversation/jx71x8m" });
    // Every step is named by its station, even when its result says it too.
    expect(phase("check").steps.map((s) => s.label)).toEqual(["Verify", "Eval", "Review"]);
  });

  test("a merge left to a person is not a failure of a run that shipped", () => {
    const ship = phase("ship");
    // Ship and the merge the line could not do are one fact, said in one row.
    expect(ship.steps.map((s) => [s.id, s.state])).toEqual([["merge", "noted"], ["watch", "done"]]);
    expect(ship.steps[0]).toMatchObject({ label: "Ship", note: "the line could not merge it", href: "/tasks/ct-56750" });
    expect(ship.steps[0].result).toMatch(/^Landed by hand \w+ \d+$/);
    expect(ship.state).toBe("done");
    const open = runPath(shippedRun, null, { status: "in_progress" }).find((p) => p.key === "ship")!;
    expect(open.steps[0].result).toBe("Left to a person to land");
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
    expect(steps.find((s) => s.id === "ship")).toMatchObject({ state: "noted", result: "Skipped: the card was withdrawn" });
    expect(runOutcome(withdrawn)).toMatchObject({ tone: "closed", text: "Stopped: the card was withdrawn." });
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
    expect(runOutcome(shippedRun, { status: "open" }, now)).toMatchObject({ tone: "failed", text: `Shipped ${day}, then reopened: its signal came back during the watch.` });
  });

  test("a row says what the run did, without its day, the watch or the task", () => {
    expect(runOutcome(shippedRun, { short_id: "ct-56750", status: "done", watch_until: T0 + 7 * DAY }, now, true).text).toBe("Shipped by hand.");
    expect(runOutcome(shippedRun, { status: "in_progress" }, now, true).text).toBe("Shipped.");
  });

  test("the other ends, and a run still going", () => {
    const ends = (ids: string[], extra: Partial<ReportRun> = {}) => ({ ...shippedRun, ...extra, node_statuses: [n("ground", 1), ...ids.map((id, i) => n(id, i + 2))] });
    expect(runOutcome(ends(["decide", "drop"])).text).toBe("Dropped at the card.");
    expect(runOutcome(ends(["plan_gate", "drop"])).text).toBe("Dropped at the plan.");
    expect(runOutcome(ends(["prove", "dissolve"])).text).toBe("Closed without a change: the problem did not reproduce.");
    expect(runOutcome(ends(["park"]), { status: "open", readiness_note: "No goal named" }).text).toBe("Parked: the cause is not ready to build. No goal named.");
    expect(runOutcome({ ...shippedRun, status: "running", current_node_id: "implement" }).text).toBe("Working: at Implement.");
    expect(runOutcome({ ...shippedRun, status: "paused", gate_node_id: "decide" }).text).toBe("Waiting for an answer on the card.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)" }).text).toBe("Stopped at Prove: Prove finished, and the line has no route for that result yet.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "prove", fail_reason: "no outgoing edge from prove (outcome failure, review_verdict none)" }).text).toBe("Stopped at Prove: Prove failed outright, and the line has no route for that yet.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "prove", fail_reason: "max_visits=2 exceeded on prove" }).text).toBe("Stopped: Prove looped twice.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "implement", fail_reason: "max_visits=3 exceeded on implement" }).text).toBe("Stopped: Implement looped three times.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "prove", fail_reason: "hand jx79xc0 killed after 30m at prove" }).text).toBe("Stopped: Prove's session ran out of time.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "decide", fail_reason: "gate withdrawn" }).text).toBe("Stopped: the card was withdrawn.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "plan_gate", gate_node_id: "plan_gate", fail_reason: "gate withdrawn" }).text).toBe("Stopped: the question was withdrawn.");
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "red", fail_reason: "the runner was stopped (SIGINT) at red" })).toMatchObject({ tone: "closed", text: "Stopped by hand during Red." });
    expect(runOutcome({ ...shippedRun, status: "failed", current_node_id: "verify", fail_reason: "checks timed out" }).text).toBe("Stopped at Verify: checks timed out.");
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

describe("stationHistory (LX3)", () => {
  const at = (id: string, hash: string, nodes: Array<{ id: string; h: string }>, day: number, extra: Partial<ReportRun> = {}): ReportRun =>
    ({ ...shippedRun, _id: id, graph_hash: hash, graph_nodes: nodes, created_at: T0 + day * DAY, ...extra });
  const v1 = at("v1", "h1", [{ id: "prove", h: "p1" }, { id: "review", h: "r1" }], 0);
  const v2 = at("v2", "h2", [{ id: "prove", h: "p1" }, { id: "review", h: "r2" }], 1, { status: "failed", gate_answer: undefined, node_statuses: [n("ground", 1), n("prove", 2, "failed")] });
  const v3 = at("v3", "h3", [{ id: "prove", h: "p2" }, { id: "review", h: "r2" }], 2);

  test("a station's history lists only the versions that changed it, and counts runs of the same text across versions", () => {
    const versions = projectLineVersions({ runs: [v3, v2, v1], signals: [] });
    expect(stationHistory(versions, "prove")).toEqual([
      { hash: "h3", first: v3.created_at, last: v3.created_at, runs: 1, shipped: 1, stopped: 0, change: "edited" },
      { hash: "h1", first: v1.created_at, last: v2.created_at, runs: 2, shipped: 1, stopped: 1, change: "first" },
    ]);
    expect(stationHistory(versions, "review").map((v) => [v.hash, v.change])).toEqual([["h2", "edited"], ["h1", "first"]]);
  });

  test("a station added or removed says so, and versions without per-station hashes say nothing", () => {
    const v4 = at("v4", "h4", [{ id: "prove", h: "p2" }, { id: "review", h: "r2" }, { id: "eval", h: "e1" }], 3);
    const v5 = at("v5", "h5", [{ id: "prove", h: "p2" }, { id: "review", h: "r2" }], 4);
    const old = { ...shippedRun, _id: "v0", graph_hash: "h0", graph_nodes: undefined, created_at: T0 - DAY };
    const versions = projectLineVersions({ runs: [v5, v4, v3, old], signals: [] });
    expect(stationHistory(versions, "eval").map((v) => v.change)).toEqual(["removed", "added"]);
  });

  test("a reopened signal after the ship counts against its version", () => {
    const [row] = projectLineVersions({ runs: [v1], signals: [{ task_id: "t1", reopened: true, created_at: T0 + 99_000 }] });
    expect(row.reopened).toBe(1);
  });
});

describe("causeWhere", () => {
  const now = T0 + DAY;
  test("the run speaks while it runs; the status and the watch after", () => {
    expect(causeWhere({ status: "in_review" }, { ...shippedRun, status: "paused", gate_node_id: "decide" }, false, now).text).toBe("Waiting for an answer on the card.");
    // A shipped cause reads as its run's outcome does: one sentence, one day.
    const task = { status: "done", watch_until: T0 + 7 * DAY };
    expect(causeWhere(task, shippedRun, false, now).text).toBe(runOutcome(shippedRun, task, now).text);
    expect(causeWhere(task, null, false, now).text).toBe(`Shipped. Watching for the problem to come back until ${shortDay(T0 + 7 * DAY)}.`);
    expect(causeWhere({ status: "open" }, shippedRun, true, now).text).toBe("Reopened: its signal came back during the watch.");
    expect(causeWhere({ status: "open" }, null, false, now).text).toBe("Waiting to be admitted.");
    expect(causeWhere({ status: "dropped" }, shippedRun, false, now).text).toBe("Dropped.");
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
  test("every station says what it does, and the main path leaves the branches out", () => {
    const all = LINE_PHASES.flatMap((p) => p.stations);
    for (const id of all) expect(stationWords(id)).toBeTruthy();
    expect(all.filter((id) => !isMainStation(id)).sort()).toEqual(["card", "card_draft", "card_write", "dissolve", "drop", "park", "plan", "plan_gate", "reopen", "unscored"]);
    // No insider word for the problem.
    for (const id of all) expect(stationWords(id)).not.toMatch(/\bmiss\b/);
  });
});
