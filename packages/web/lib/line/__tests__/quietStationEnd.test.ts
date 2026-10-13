// Step page fixes (line-journeys.md LJ8.6): a station whose session went quiet without a report says how it ended,
// never "ended without a report; start again or close the problem", and a fix main already carries waits on a close.
import { describe, expect, test } from "bun:test";
import type { LineStep, StepDecision } from "../lineModel";
import { failCause, stationEnd, stepFailWords, type ReportRun } from "../runReport";
import { stepTable } from "../stepTable";

// ct-57637's Prove, Oct 13: the session ended its turn to wait on its own replays, the engine read that turn's end as
// the station's at 16:24, and the session went on working until 16:33.
const quietRun = (session: Record<string, unknown>) => ({
  _id: "th7d825f", status: "failed", current_node_id: "prove", created_at: 0, updated_at: 0,
  fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)",
  node_statuses: [{ node_id: "prove", status: "failed", session_id: "jx7cvr7", started_at: 1_791_907_911_746, completed_at: 1_791_908_652_724,
    session: { _id: "jx7cvr720", message_count: 109, result: "", ...session } }],
}) as unknown as ReportRun;

describe("a station whose session went quiet without a report", () => {
  test("is its own cause, named by how it ended, and how long the session went on after", () => {
    const run = quietRun({ is_active: false, updated_at: 1_791_909_224_487 });
    expect(failCause(run)).toMatchObject({ key: "quiet:prove", label: "Prove's session went quiet without a report" });
    expect(stepFailWords(run, "prove")).toBe("Prove's session went quiet without a report and the line took that as its end; its session kept working 10m after.");
    expect(stepFailWords(run, "prove")).not.toMatch(/start again or close/);
  });
  test("a session still at work says so", () => {
    expect(stepFailWords(quietRun({ is_active: true, updated_at: 1_791_908_800_000 }), "prove")).toMatch(/; its session is still working\.$/);
  });
  test("a session that pinned a report or handed back is not quiet", () => {
    const pinned = quietRun({ state: "Reproduced 3 of 3", state_status: "done" });
    const n = (pinned.node_statuses as Array<{ node_id: string; status: string; session: never; completed_at: number }>)[0];
    expect(stationEnd({ id: "prove", status: "failed", session: n.session, completed_at: n.completed_at }, pinned)?.kind).not.toBe("went_quiet");
  });
});

const d = (id: string, status: StepDecision["status"]): StepDecision => ({
  id: `run-${id}:park`, runId: `run-${id}`, caseId: `c-${id}`, caseRef: `ct-${id}`, caseTitle: `Problem ${id}`, at: 1000, durationMs: null, status,
  received: { from: null, fromLabel: null, summary: "", said: false, sessionId: null, href: null },
  decided: { outcome: status === "failed" ? "failed" : null, words: "parked", result: null, to: null, toLabel: null, toWords: null },
  reasoning: null, label: null, labels: [],
});

describe("a fix main already carries", () => {
  test("waits at its step as one to close, apart from a go-on", () => {
    const park: LineStep = { id: "park", kind: "script", label: "Park", fileLabel: null, purpose: "", stage: "understand", half: "diagnose", prompt: null, outcomes: [], answers: [],
      decisions: [d("k1", "failed"), d("k2", "failed")], tally: {} as LineStep["tally"], model: null, maxVisits: null, timeoutS: null };
    const runs = ["k1", "k2"].map((k) => ({ id: `run-${k}`, visits: [{ node: "park", inferred: false, kind: "script" }] })) as never;
    const needs = ["k1", "k2"].map((k) => ({ runId: `run-${k}`, caseId: `c-${k}`, kind: "fixed", counted: true }));
    const [row] = stepTable({ steps: { park }, order: ["park"], runs }, new Map(), undefined, needs);
    expect(row).toMatchObject({ onYou: 2, toClose: 2, others: 0, running: 0 });
  });
});
