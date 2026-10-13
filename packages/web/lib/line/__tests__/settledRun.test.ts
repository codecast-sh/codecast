import { describe, expect, test } from "bun:test";
import { failCause, runPath, settledRun, type ReportRun } from "../runReport";

// ct-57972 (2026-10-13): two machines ran one run. The laptop's runner proved the miss and went on (red, implement,
// verify, eval); the cloud host's runner sat on an empty Prove hand for 3h, then reported Prove failed and the run
// failed over the live one. Its later reports cleared the reason and left the failed status.
const T = 1_791_883_210_455;
const twoRunners = (over: Partial<ReportRun> = {}): ReportRun => ({
  _id: "th769",
  status: "failed",
  current_node_id: "eval",
  node_statuses: [
    { node_id: "start", status: "completed", started_at: T - 400_000 },
    { node_id: "ground", status: "completed", started_at: T - 300_000, completed_at: T - 200_000 },
    { node_id: "analyze", status: "completed", started_at: T - 200_000, completed_at: T - 2_000 },
    { node_id: "prove", status: "failed", started_at: T, completed_at: T + 10_816_000, session_id: "jx71c74",
      result_preview: "Showed the WhatsApp escalation miss on the base; prove exits 0.",
      session: { _id: "jx71c74", message_count: 0, killed: true } },
    { node_id: "red", status: "completed", started_at: T + 3_200_000, completed_at: T + 6_400_000, result_preview: "{\"red\": true}" },
    { node_id: "implement", status: "completed", started_at: T + 10_500_000, completed_at: T + 11_500_000, session_id: "jx7dq1j", session: { _id: "jx7dq1j", message_count: 75 } },
    { node_id: "verify", status: "completed", started_at: T + 11_500_100, completed_at: T + 11_530_000 },
    { node_id: "eval", status: "running", started_at: T + 11_530_100 },
  ],
  ...over,
});

describe("settledRun", () => {
  test("a station the run went on from passed, whatever a later report wrote", () => {
    const s = settledRun(twoRunners());
    const prove = s.node_statuses!.find((n) => n.node_id === "prove")!;
    expect(prove.status).toBe("completed");
    // The empty hand was the other runner's, not the one that proved it.
    expect(prove.session).toBeNull();
    expect(prove.result_preview).toContain("prove exits 0");
    // Nothing in the row says a runner is still on it: it failed where it got to, not at Prove.
    expect(s.status).toBe("failed");
    expect(runPath(s).flatMap((p) => p.steps).find((x) => x.id === "prove")?.state).not.toBe("failed");
  });

  test("a stale reason and place naming the station go with it", () => {
    const s = settledRun(twoRunners({ fail_reason: "hand jx71c74 killed after 180m at prove", current_node_id: "prove" }));
    expect(s.fail_reason).toBeUndefined();
    expect(s.current_node_id).toBe("eval");
    expect(failCause(s).step).toBe("eval");
    expect(failCause(s).label).not.toBe("Its session never started");
  });

  test("a failure on a route the runner takes only on failure is a real one", () => {
    // Eval failed and the runner went to implement on its failure edge: eval failed.
    const run = twoRunners({ fail_reason: "max_visits=3 exceeded on implement" });
    run.node_statuses = run.node_statuses!.map((n) => (n.node_id === "prove" ? { ...n, status: "completed" } : n.node_id === "eval" ? { ...n, status: "failed", started_at: T + 9_000_000 } : n));
    const s = settledRun(run);
    expect(s.node_statuses!.find((n) => n.node_id === "eval")!.status).toBe("failed");
    expect(s.status).toBe("failed");
  });

  test("a station that failed with nothing after it stays failed", () => {
    const run = twoRunners({ fail_reason: "hand jx71c74 killed after 180m at prove" });
    run.node_statuses = run.node_statuses!.filter((n) => ["start", "ground", "analyze", "prove"].includes(n.node_id));
    const s = settledRun(run);
    expect(s).toBe(run);
    expect(s.node_statuses!.find((n) => n.node_id === "prove")!.status).toBe("failed");
  });

  test("the same row reads as the same object", () => {
    const run = twoRunners();
    expect(settledRun(run)).toBe(settledRun(run));
  });
});
