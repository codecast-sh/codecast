// A station that pinned itself blocked where its run stopped (a dead end after Prove): every reader says why in the
// station's own words, the opened step leads with its pin, and starting again leads its review with the block.
import { describe, expect, test } from "bun:test";
import { failCause, stepFailWords, stopWords, type ReportRun } from "../runReport";
import { runFactsByStep, stepWaits, type StepTableRow } from "../stepTable";
import { startAgainLedger } from "../../../components/consequential/ledgers";

const REASON = "Miss reproduced on base (3 of 3 cases), but prove cannot finish: the replay tool cuts its output when piped, so the tool fix must land on main first.";
const run = {
  _id: "run-b", status: "failed", current_node_id: "prove", created_at: 1, updated_at: 2,
  fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)",
  node_statuses: [{ node_id: "prove", status: "failed", session_id: "jx1", completed_at: 2,
    session: { _id: "s1", state: `${REASON}\n\nTried twice.\n\`\`\`json\n{"reproduced": true}\n\`\`\``, state_status: "blocked", message_count: 40 } }],
} as unknown as ReportRun;

describe("a station that pinned itself blocked", () => {
  test("the cause carries its first paragraph whole, and the stop says it, never 'failed; see what it tried'", () => {
    expect(failCause(run).blocked).toBe(REASON);
    expect(stopWords(run)).toBe(`Stopped at Prove: Prove is blocked: ${REASON.replace(/\.$/, "")}.`);
    expect(stepFailWords(run, "prove")).not.toMatch(/see what it tried/);
  });
  test("the step's facts keep the reason for the row's Start again", () => {
    expect(runFactsByStep([run] as any).get("prove")?.causes.get("run-b")?.blocked).toBe(REASON);
  });
  test("starting again leads its review with the block, whole, in a row", () => {
    const l = startAgainLedger({ problem: "ct-1 · A problem", project: null, hold: REASON });
    expect(l.alert).toBe("The last run stopped blocked");
    expect(l.rows[0]).toEqual({ k: "Blocked", v: REASON, tone: "warn" });
    expect(startAgainLedger({ problem: "ct-1", project: null }).alert).toBeUndefined();
  });
});

describe("the Map's waiting badge reads the Steps table", () => {
  test("each step with a wait, split on you and on someone else; a step nothing waits at has none", () => {
    const row = (id: string, onYou: number, others: number) => ({ id, onYou, others }) as StepTableRow;
    const w = stepWaits([row("plan_gate", 0, 1), row("prove", 6, 0), row("verify", 0, 0)]);
    expect(w.get("prove")).toEqual({ onYou: 6, others: 0 });
    expect(w.get("plan_gate")).toEqual({ onYou: 0, others: 1 });
    expect(w.has("verify")).toBe(false);
  });
});
