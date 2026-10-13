// A fix decision a teammate answered after its gate node gave up waiting
// (ct-57444, Oct 12): the run's `decide` node recorded "failure" at 19:58, two
// minutes after the card was asked; the card stayed open and Cam answered Ship
// at 20:05; ship ran with the line's merge step off. The decision is the record
// of the answer, so the problem is approved and not merged, never "unanswered"
// and never filed under Needs a new ask.
import { describe, expect, test } from "bun:test";
import { CARD_GATE_NODE_ID, lineRunOutcome, passedUnansweredCard } from "@codecast/shared/contracts/changeCard";
import { unapprovedShips } from "../../lineFlow";
import { causeHistory } from "../causeHistory";
import type { MapDecision, MapRun } from "../lineMap";
import { bandLine, problemBand, problemNow, type BandInput } from "../problemPage";
import type { LineIssue } from "../lineModel";

const MIN = 60_000;
const ASKED = Date.UTC(2026, 9, 12, 19, 56);
const NOW = Date.UTC(2026, 9, 13, 10);
const node = (node_id: string, at: number, outcome: string | null = "success", status = "completed") => ({ node_id, status, outcome, started_at: at - MIN, completed_at: at });

const nodes = [
  node("start", ASKED - 100 * MIN), node("ground", ASKED - 95 * MIN), node("implement", ASKED - 60 * MIN), node("card", ASKED),
  node(CARD_GATE_NODE_ID, ASKED + 2 * MIN, "failure", "failed"),
  { ...node("ship", ASKED + 16 * MIN), result_preview: "not merged: merge is off for this line; a person turns it on with cast role line --merge on\nok Comment added to ct-57444" },
  node("watch", ASKED + 17 * MIN), node("exit", ASKED + 17 * MIN, null),
];
const answeredGate = { gate_node_id: CARD_GATE_NODE_ID, gate_decision_status: "answered", gate_answer: "Ship", gate_response: "S" };
const run = (gate: object) => ({
  _id: "run2", task_id: "t1", status: "completed", created_at: ASKED - 100 * MIN, updated_at: ASKED + 17 * MIN, started_at: ASKED - 100 * MIN, node_statuses: nodes, ...gate,
}) as unknown as MapRun;
const decision = (status: string): MapDecision => ({
  _id: "d590", short_id: "sd-590", task_id: "t1", workflow_run_id: "run2", gate_node_id: CARD_GATE_NODE_ID, status, created_at: ASKED,
  options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }],
  ...(status === "answered" ? { answer_index: 0, resolved_at: ASKED + 9 * MIN, answered_by: { kind: "user", id: "cam" } } : {}),
} as unknown as MapDecision);

const history = (r: MapRun, d: MapDecision) => causeHistory({
  task: undefined, runs: [r], decisions: [d], signals: [], occurrences: undefined, deploys: [], said: () => ({ found: null, proposed: null, built: null, argued: null }) as never, watchDays: null, now: NOW,
});
const issue = (h: ReturnType<typeof history>): LineIssue => ({
  id: "t1", ref: "ct-57444", title: "A dead match still says the intro is waiting", status: "in_review", findings: 4, quotes: [], runs: ["run2"], lastRunAt: 0,
  where: { tone: "calm", end: null, text: "" }, history: h, ask: null, dissolvedWhy: null, dissolvedFixedAt: null,
});
const band = (h: ReturnType<typeof history>, o: Partial<BandInput> = {}) => problemBand({
  issue: issue(h), history: h, run: null, need: null, decision: null, row: null, task: { status: "in_review", goal_ref: "in-1" }, lineOn: true, now: NOW,
  shipOutput: nodes[5].result_preview, ...o,
});

describe("a fix decision a teammate answered after its gate node failed (ct-57444)", () => {
  test("the run's record of the answer outranks the gate node's failure", () => {
    expect(passedUnansweredCard(nodes, answeredGate)).toBe(false);
    expect(passedUnansweredCard(nodes)).toBe(true);
    expect(lineRunOutcome(nodes, answeredGate)?.kind).toBe("shipped");
  });
  test("it is never an unapproved ship, so no 'lapsed' need is raised for it", () => {
    const task = { _id: "t1", status: "in_review" };
    expect(unapprovedShips([task], [run(answeredGate)], NOW)).toEqual([]);
    // Without an answer on record it still is one.
    expect(unapprovedShips([task], [run({ gate_node_id: CARD_GATE_NODE_ID, gate_decision_status: "withdrawn" })], NOW)).toEqual(["t1"]);
  });
  test("the problem is approved and not merged, names who approved, and is never newask or unanswered", () => {
    const h = history(run(answeredGate), decision("answered"));
    expect(h.attempts[0].unapproved).toBe(false);
    expect(h.attempts[0].card?.answeredBy).toBe("cam");
    const b = band(h, { approver: "Cam" });
    expect(b).toMatchObject({ kind: "approved", ref: "sd-590", by: "Cam", mergeOff: true });
    expect(bandLine(b).text).toMatch(/^Approved \w+ \d+, not merged$/);
    expect(problemNow(b).status).toBe("approved");
    expect(problemNow(b).status).not.toBe("newask");
  });
  test("an unanswered card on the same run still reads as unanswered", () => {
    const h = history(run({ gate_node_id: CARD_GATE_NODE_ID, gate_decision_status: "withdrawn" }), decision("withdrawn"));
    expect(h.attempts[0].unapproved).toBe(true);
    expect(problemNow(band(h, { need: { kind: "lapsed", since: ASKED, fail: null } })).status).toBe("newask");
  });
});

describe("a run far past its usual time (ct-57839: running 1.4h, usually 17m)", () => {
  test("is overrunning from three times its usual, and not before or without a usual", async () => {
    const { overrun, stopRunLedger } = await import("../problemPage");
    expect(overrun(84 * MIN, 17 * MIN)).toBe(4);
    expect(overrun(40 * MIN, 17 * MIN)).toBeNull();
    expect(overrun(84 * MIN, null)).toBeNull();
    const l = stopRunLedger({ problem: "ct-57839", step: "Implement", ms: 84 * MIN, usual: 17 * MIN });
    expect(l).toMatchObject({ name: "Stop the run", shift: null, confirm: "Stop the run", keep: "Keep running" });
    expect(l.figures.map((f) => f.value)).toEqual(["1.4h", "17m"]);
  });
  test("a live run row waiting on a person says how long it has waited, never 'now' (ct-59730)", async () => {
    const { workRows } = await import("../problemPage");
    const live = { ...history(run(answeredGate), decision("answered")).attempts[0], live: true, end: null, card: null, merge: null, ended: null, unapproved: false };
    const h = { ...history(run(answeredGate), decision("answered")), attempts: [live] };
    const visits = [{ node: "decide", label: "Decide", kind: "person", status: "waiting", startedAt: ASKED, at: ASKED, inferred: false, decided: { words: "" }, why: null }];
    const [row] = workRows(h as never, [{ id: "run2", status: "paused", visits, outcome: { tone: "calm", end: null, text: "" } } as never]);
    expect(row.durationMs).toBeNull();
    expect(row.waitingSince).toBe(ASKED);
  });
});
