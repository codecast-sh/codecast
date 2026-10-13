// One decision's state, read the same on every page (decisionOutcome). The
// cases are the real shapes the Decide step misfiled: a card that lapsed while
// its run went on to ship (ct-58022), a card taken back (ct-59433), a run that
// ended before anything was asked (ct-59242), and a trial's Ship (ct-59229).
import { describe, expect, test } from "bun:test";
import { decisionOutcome, gateCard, noAnswerFacts } from "../decisionOutcome";

const opts = [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }];

describe("decisionOutcome", () => {
  test("a card nobody answered while its run went on to ship has lapsed: never an answer, never 'shipped'", () => {
    const o = decisionOutcome({ status: "withdrawn", options: opts, short_id: "sd-512" }, {
      status: "completed", current_node_id: "exit", gate_node_id: "decide", gate_decision_status: "withdrawn",
      node_statuses: [{ node_id: "decide", status: "failed", outcome: "failure" }, { node_id: "ship", status: "completed", outcome: "success" }],
    } as any, { gate: "decide" });
    expect(o).toMatchObject({ state: "lapsed", verb: null, words: "Lapsed", ref: "sd-512" });
  });

  test("a card taken back is withdrawn, with the run's own reason", () => {
    const o = decisionOutcome({ status: "withdrawn", options: opts }, {
      status: "failed", current_node_id: "decide", fail_reason: "Stopped: its fix was set aside and the problem is due a new run",
      node_statuses: [{ node_id: "decide", status: "running" }],
    }, { gate: "decide" });
    expect(o).toMatchObject({ state: "withdrawn", words: "Withdrawn", why: "Its fix was set aside and the problem is due a new run" });
  });

  test("a run that ended at the gate before anything was asked is withdrawn, not waiting", () => {
    const o = decisionOutcome(null, { status: "failed", current_node_id: "decide", fail_reason: "Stopped: the problem was merged into another while the run waited", node_statuses: [{ node_id: "decide", status: "failed" }] }, { gate: "decide" });
    expect(o.state).toBe("withdrawn");
    expect(o.why).toBe("The problem was merged into another while the run waited");
  });

  test("an answer is its option's words; a trial answer says it was only recorded", () => {
    const card = { status: "answered", options: opts, answer_index: 0 };
    expect(decisionOutcome(card, { status: "completed" }, { gate: "decide" })).toMatchObject({ state: "answered", verb: "Ship", words: "Ship", trial: false });
    expect(decisionOutcome(card, { status: "completed" }, { gate: "decide", trial: true })).toMatchObject({ state: "answered", verb: "Ship", words: "Would ship · trial", trial: true });
    // The gate's own answer counts when the card row is not at hand.
    expect(decisionOutcome(null, { status: "completed", gate_node_id: "decide", gate_answer: "[R] Revise" }, { gate: "decide" })).toMatchObject({ state: "answered", verb: "Revise" });
  });

  test("an open card on a run paused at its gate waits; a history attempt past its card lapsed", () => {
    expect(decisionOutcome({ status: "pending" }, { status: "paused", current_node_id: "decide" }, { gate: "decide" }).state).toBe("waiting");
    expect(decisionOutcome({ status: "withdrawn" }, null, { unapproved: true }).state).toBe("lapsed");
  });

  test("the card a gate asked is the run's newest for that gate", () => {
    const cards = [
      { _id: "a", workflow_run_id: "r", gate_node_id: "decide", created_at: 1 },
      { _id: "b", workflow_run_id: "r", gate_node_id: "decide", created_at: 3 },
      { _id: "c", workflow_run_id: "r", gate_node_id: "approve", created_at: 5 },
      { _id: "d", workflow_run_id: "other", gate_node_id: "decide", created_at: 9 },
    ];
    expect(gateCard(cards, "r", "decide")?._id).toBe("b");
    expect(gateCard(cards, "r", "approve")?._id).toBe("c");
  });
});

describe("noAnswerFacts (ct-58282)", () => {
  const nodes = (ship: { status: string; result_preview: string }) => [
    { node_id: "card", status: "completed" },
    { node_id: "decide", status: "failed", outcome: "failure", started_at: 1_000, completed_at: 1_000 + 3.2 * 3_600_000 },
    { node_id: "ship", ...ship },
  ];
  test("the run stopped waiting after 3h and Ship refused a stale branch", () => {
    const f = noAnswerFacts({ status: "completed", node_statuses: nodes({ status: "failed", result_preview: "line: codecast/line-ct-58282 is behind origin/main; rebase it first\nthe ship command exited 1" }) });
    expect(f).toEqual({ by: "The line, when its run ended", waited: 3.2 * 3_600_000, then: "Ship ran with no yes, refused: branch behind main" });
  });
  test("Ship ran with the merge step off", () => {
    const f = noAnswerFacts({ status: "completed", node_statuses: nodes({ status: "completed", result_preview: "ship: no Requested-by\nnot merged: merge is off for this line; a person turns it on" }) });
    expect(f?.then).toBe("Ship ran with no yes, nothing merged (merge step off)");
  });
  test("a session's own cancel names the session", () => {
    expect(noAnswerFacts({ status: "failed", fail_reason: "gate withdrawn", node_statuses: [{ node_id: "decide", status: "running" }] })).toEqual({ by: "The session that asked it", waited: null, then: null });
  });
});
