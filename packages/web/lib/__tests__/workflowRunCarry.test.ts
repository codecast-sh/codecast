import { describe, expect, test } from "bun:test";
import { carryNodeSessions } from "../workflowRun";

// The line floor's feed runs out of its session budget on older runs; the
// cause's own feed attached them. A bare push must not strip what a station
// reported (ct-57659's trace read "failed outright" for a builder that asked).
describe("carryNodeSessions", () => {
  const session = { _id: "jx7ajkgs", handoff: { status: "needs_context" } };
  const held = { r1: { _id: "r1", node_statuses: [{ node_id: "implement_line", session_id: "jx7ajkg", session }] } };

  test("a bare node keeps the session held for the same node and hand", () => {
    const out = carryNodeSessions([{ _id: "r1", node_statuses: [{ node_id: "implement_line", session_id: "jx7ajkg" }] }], held);
    expect(out[0].node_statuses![0].session).toBe(session);
  });

  test("a node with its own session, another hand, or nothing held passes through unchanged", () => {
    const fresh = [{ _id: "r1", node_statuses: [{ node_id: "implement_line", session_id: "jx7ajkg", session: { _id: "new" } }] }];
    expect(carryNodeSessions(fresh, held)).toBe(fresh);
    const other = [{ _id: "r1", node_statuses: [{ node_id: "implement_line", session_id: "jx7zzzz" }] }];
    expect(carryNodeSessions(other, held)).toBe(other);
    const unheld = [{ _id: "r2", node_statuses: [{ node_id: "implement_line", session_id: "jx7ajkg" }] }];
    expect(carryNodeSessions(unheld, held)).toBe(unheld);
  });
});
